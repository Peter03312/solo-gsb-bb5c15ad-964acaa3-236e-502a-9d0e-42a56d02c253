'use strict';

/**
 * 等待申请 HTTP 端到端测试：启动真实服务，经 REST API 验证
 * 鉴权/权限、提交/撤销、自动兑现、退出撤销、管理员改定义失效、重置撤销、重启兑现。
 *
 * 运行：node test/api-waiting.cjs
 */
process.env.SEED_DEMO = '1';
process.env.PORT = String(process.env.TEST_PORT || 3199);
process.env.DB_PATH = process.env.API_DB || './data/api-waiting-test.db';
process.env.ADMIN_PASSWORD = 'admin123';

const fs = require('fs');
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + ext); } catch (_) {}
}

const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓', name); passed++; }
  else { console.log('  ✗', name, extra || ''); failed++; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(base) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('服务未在 5s 内启动');
}

function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2000);
  });
}

async function main() {
  const base = `http://localhost:${process.env.PORT}`;
  let server = startServer();
  await waitForServer(base);

  const api = async (method, path, { token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const resp = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    return { status: resp.status, data };
  };

  const login = async (name) => {
    const r = await api('POST', '/api/auth/login/dispatcher', { body: { name } });
    return r.data.token;
  };

  try {
    console.log('\n[1] 未登录访问被拒');
    const noauth = await api('GET', '/api/waiting');
    ok('未登录 401', noauth.status === 401);

    console.log('\n[2] 提交等待申请：非法入参/未知进路/道岔不符 拒绝');
    const t1 = await login('甲');
    let r = await api('POST', '/api/routes/RX/wait', { token: t1, body: { switchPositions: {} } });
    ok('未知进路 404 ROUTE_NOT_FOUND',
      r.status === 404 && r.data.code === 'ROUTE_NOT_FOUND', JSON.stringify(r.data));
    r = await api('POST', '/api/routes/R1/wait', { token: t1, body: { switchPositions: [] } });
    ok('switchPositions 非对象 400', r.status === 400 && r.data.code === 'BAD_SWITCH_POSITIONS');
    r = await api('POST', '/api/routes/R1/wait', { token: t1, body: { switchPositions: { SW8: 'N' } } });
    ok('缺失道岔选择 400', r.status === 400 && r.data.code === 'SWITCH_NOT_CHOSEN');
    r = await api('POST', '/api/routes/R1/wait',
      { token: t1, body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
    ok('道岔选择与定义不符 409', r.status === 409 && r.data.code === 'SWITCH_POSITION_MISMATCH');

    console.log('\n[3] 资源满足：提交即兑现，返回实例编号');
    r = await api('POST', '/api/routes/R1/wait',
      { token: t1, body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
    ok('提交成功', r.status === 200 && r.data.request.status === 'fulfilled');
    const instId = r.data.instance && r.data.instance.id;
    ok('响应直接带已开放实例', typeof instId === 'number');

    console.log('\n[4] 状态快照与列表（本人 / 全班）');
    const t2 = await login('乙');
    r = await api('GET', '/api/waiting', { token: t2 });
    ok('默认仅本人，乙看不到甲的申请',
      r.status === 200 && r.data.requests.every((w) => w.applicant === '乙'));
    r = await api('GET', '/api/waiting?all=1', { token: t2 });
    ok('?all=1 可看全班',
      r.status === 200 && r.data.requests.some((w) => w.applicant === '甲'));
    r = await api('GET', '/api/state', { token: t2 });
    ok('/api/state 含 waitingRequests',
      Array.isArray(r.data.state.waitingRequests)
      && r.data.state.waitingRequests.some((w) => w.instanceId === instId));

    // 走行解除 R1，释放资源
    const ev = async (seq, sectionId, action) =>
      api('POST', `/api/instances/${instId}/events`, { token: t1, body: { seq, sectionId, action } });
    for (const [seq, sid, act] of [
      [1, '1', 'occupy'], [2, '3', 'occupy'], [3, '1', 'clear'],
      [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
    ]) {
      const e = await ev(seq, sid, act);
      ok(`事件 #${seq} ${act}${sid} 接受`, e.status === 200, JSON.stringify(e.data));
    }

    console.log('\n[5] 资源不满足排队 + 非本人撤销拒绝 + 本人撤销成功');
    // 甲先开 R1 锁住资源
    const openR1 = await api('POST', '/api/routes/R1/open',
      { token: t1, body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
    ok('甲重新开放 R1', openR1.status === 200);
    // 乙对冲突进路 R2（需扳 SW8）排队；SW8 实际 N，本就不能开
    r = await api('POST', '/api/routes/R2/wait',
      { token: t2, body: { switchPositions: { SW7: 'N', SW8: 'R' } } });
    ok('乙的申请进入等待', r.status === 200 && r.data.request.status === 'waiting');
    const wId = r.data.request.id;
    ok('返回顺位', r.data.request.queuePosition === 1);
    ok('阻断原因非空', r.data.request.blockReasons.length > 0);

    const t3 = await login('丙');
    r = await api('DELETE', `/api/waiting/${wId}`, { token: t3 });
    ok('非本人撤销 403', r.status === 403 && r.data.code === 'NOT_OWNER');
    r = await api('DELETE', `/api/waiting/${wId}`, { token: t2 });
    ok('等待中他人仍不能影响：本人撤销前先验证重复撤销→ 本人撤销 200',
      r.status === 200 && r.data.request.status === 'cancelled');
    r = await api('DELETE', `/api/waiting/${wId}`, { token: t2 });
    ok('重复撤销 409 WAITING_NOT_ACTIVE', r.status === 409 && r.data.code === 'WAITING_NOT_ACTIVE');

    console.log('\n[6] 进路解除自动兑现：乙再排队，甲走行解除后乙自动兑现');
    r = await api('POST', '/api/routes/R2/wait',
      { token: t2, body: { switchPositions: { SW7: 'N', SW8: 'R' } } });
    const wId2 = r.data.request.id;
    ok('再次排队', r.data.request.status === 'waiting');
    // 扳 SW8 到 R（R1 锁着 SW8，应拒绝 → 先让甲走行解除；解除时 SW8 实际仍是 N，
    // 乙还不能兑现；随后乙扳 SW8=R，扳动触发兑现）
    const r1id = openR1.data.instance.id;
    const ev1 = async (seq, sid, act) =>
      api('POST', `/api/instances/${r1id}/events`, { token: t1, body: { seq, sectionId: sid, action: act } });
    for (const [seq, sid, act] of [
      [1, '1', 'occupy'], [2, '3', 'occupy'], [3, '1', 'clear'],
      [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
    ]) {
      const e = await ev1(seq, sid, act);
      if (e.status !== 200) { ok(`R1 走行 #${seq} 接受`, false, JSON.stringify(e.data)); }
    }
    ok('R1 已走行解除', true);
    r = await api('GET', `/api/waiting/${wId2}`, { token: t2 });
    ok('解除但 SW8 实际 N：乙仍等待', r.data.request.status === 'waiting');
    r = await api('POST', '/api/switches/SW8/move', { token: t2, body: { position: 'R' } });
    ok('扳道岔 200', r.status === 200 && r.data.result.fulfilled.includes(wId2));
    r = await api('GET', `/api/waiting/${wId2}`, { token: t2 });
    ok('扳动后自动兑现，得到实例编号',
      r.data.request.status === 'fulfilled' && typeof r.data.request.instanceId === 'number');

    console.log('\n[7] 申请人退出撤销其未兑现申请');
    // 乙的 R2 已开放，占用区段1 使新申请排队
    r = await api('POST', '/api/routes/R1/wait',
      { token: t2, body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
    ok('乙再提 R1 排队（资源冲突 + SW8 不符）',
      r.data.request.status === 'waiting');
    const wId3 = r.data.request.id;
    r = await api('POST', '/api/auth/logout', { token: t2 });
    ok('退出 200', r.status === 200);
    r = await api('GET', `/api/waiting/${wId3}?all=1`, { token: t1 });
    ok('退出后申请已撤销并注明原因',
      r.data.request.status === 'cancelled'
      && r.data.request.closeReason.includes('退出'));
    // 乙已开放的 R2 不受影响
    const st = await api('GET', '/api/state', { token: t1 });
    ok('乙已兑现的进路实例仍开放（退出不影响既有开放）',
      st.data.state.openInstances.some((i) => i.route_id === 'R2' || i.routeId === 'R2'));

    console.log('\n[8] 管理员修改进路定义使等待申请失效（需无开放实例：先走完 R2）');
    const r2id = (await api('GET', '/api/state', { token: t1 })).data.state.openInstances
      .find((i) => (i.route_id || i.routeId) === 'R2').id;
    const ev2 = async (seq, sid, act) =>
      api('POST', `/api/instances/${r2id}/events`, { token: t1, body: { seq, sectionId: sid, action: act } });
    for (const [seq, sid, act] of [
      [1, '1', 'occupy'], [2, '3', 'occupy'], [3, '1', 'clear'],
      [4, '4', 'occupy'], [5, '3', 'clear'], [6, '4', 'clear']
    ]) {
      const e = await ev2(seq, sid, act);
      if (e.status !== 200) ok(`R2 走行 #${seq}`, false, JSON.stringify(e.data));
    }
    ok('R2 走完', true);

    // 制造等待：区段5 占用后 R1 无法兑现
    await api('POST', '/api/sections/5/state', { token: t1, body: { action: 'occupy' } });
    r = await api('POST', '/api/routes/R1/wait',
      { token: t1, body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
    const wId4 = r.data.request.id;
    ok('R1 申请等待中', r.data.request.status === 'waiting');

    const adminLogin = await api('POST', '/api/auth/login/admin',
      { body: { password: 'admin123' } });
    const ta = adminLogin.data.token;
    ok('管理员登录', !!ta);

    // 用相同定义 PUT（定义"变更"）
    r = await api('PUT', '/api/admin/routes/R1', { token: ta, body: {
      id: 'R1', label: '正线通过 X1→X3(改)', origin: 'X1', destination: 'X3',
      entrySignalId: 'S1',
      steps: ['1', '3', '5'],
      switchReqs: [{ switchId: 'SW7', position: 'N' }, { switchId: 'SW8', position: 'N' }]
    } });
    ok('管理员修改进路 200', r.status === 200, JSON.stringify(r.data));
    r = await api('GET', `/api/waiting/${wId4}`, { token: t1 });
    ok('等待申请被置为 invalidated 且有原因',
      r.data.request.status === 'invalidated'
      && /修改/.test(r.data.request.closeReason));

    // 清空区段5，触发也不会复活失效申请
    await api('POST', '/api/sections/5/state', { token: t1, body: { action: 'clear' } });
    r = await api('GET', `/api/waiting/${wId4}`, { token: t1 });
    ok('失效不复活', r.data.request.status === 'invalidated');

    console.log('\n[9] 管理员重置撤销等待申请');
    await api('POST', '/api/sections/5/state', { token: t1, body: { action: 'occupy' } });
    r = await api('POST', '/api/routes/R1/wait',
      { token: t1, body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
    const wId5 = r.data.request.id;
    r = await api('POST', '/api/admin/reset/training', { token: ta });
    ok('重置 200', r.status === 200);
    r = await api('GET', `/api/waiting/${wId5}`, { token: t1 });
    ok('重置后申请撤销，注明原因',
      r.data.request.status === 'cancelled' && /重置/.test(r.data.request.closeReason));

    await stopServer(server);

    console.log('\n[10] 服务重启后自动尝试兑现（持久化等待申请）');
    // 重启前直接向库中插入一条"必然可兑现"的等待申请（重置后区段全空闲、道岔回 N）
    {
      const { getDb } = require('../src/db');
      const db = getDb();
      const ins = db.prepare(
        `INSERT INTO waiting_requests(route_id,applicant,switch_positions,status,block_reasons)
         VALUES('R1','重启用户','{"SW7":"N","SW8":"N"}','waiting','[]')`);
      ins.run();
      db.close();
    }
    server = startServer();
    await waitForServer(base);
    const t4 = await login('重启用户');
    r = await api('GET', '/api/waiting', { token: t4 });
    const restarted = r.data.requests.find((x) => x.applicant === '重启用户');
    ok('重启后申请已自动兑现',
      restarted && restarted.status === 'fulfilled' && typeof restarted.instanceId === 'number',
      JSON.stringify(restarted && restarted.status));
    r = await api('GET', '/api/state', { token: t4 });
    ok('重启后产生且仅产生一个开放实例',
      r.data.state.openInstances.length === 1
      && r.data.state.openInstances[0].id === restarted.instanceId);
  } finally {
    await stopServer(server);
  }

  console.log(failed === 0
    ? `\nHTTP 测试全部 ${passed} 项通过 ✅`
    : `\nHTTP 测试 ${passed} 通过 / ${failed} 失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ 测试异常:', e);
  process.exit(1);
});
