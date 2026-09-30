'use strict';

/**
 * 等待申请（排队排路）核心逻辑测试（不经过 HTTP、无需登录）。
 * 运行：node test/waiting.cjs
 */
process.env.SEED_DEMO = '1';
process.env.DB_PATH = process.env.WAITING_DB || './data/waiting-test.db';

const fs = require('fs');
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + ext); } catch (_) {}
}

const assert = require('assert');
const { getDb } = require('../src/db');
const { seedDemo } = require('../src/seed');
const inter = require('../src/interlocking');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
}
async function expectThrow(name, fn, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, `${name}：应当被拒绝，但没有抛错`);
  if (code) assert.strictEqual(threw.code, code,
    `${name}：错误码应为 ${code}，实际 ${threw.code}（${threw.message}）`);
  console.log('  ✓', name, '→', threw.message);
  passed++;
}

/** 走完整条进路（占清交错），使其自动解除 */
function walkThrough(instanceId, sections, client) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    inter.submitSectionEvent(instanceId, seq++, sections[i], 'occupy', client);
    if (i >= 1) inter.submitSectionEvent(instanceId, seq++, sections[i - 1], 'clear', client);
  }
  inter.submitSectionEvent(instanceId, seq++, sections[sections.length - 1], 'clear', client);
}

async function main() {
  seedDemo(getDb());
  const db = getDb();

  // 增加一条与 R1/R2/R3 资源完全不相交的进路 R9（仅区段 9）
  db.prepare(`INSERT INTO sections(id,label,x1,y1,x2,y2,occ_state)
              VALUES('9','9DG',0,0,10,10,'free')`).run();
  db.prepare(`INSERT INTO routes(id,label,origin,destination) VALUES('R9','专用线','X9','X0')`).run();
  db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES('R9',1,'9')`).run();

  console.log('\n[1] 提交校验：未知进路 / 未选道岔 / 选择与定义不符 一律拒绝');
  await expectThrow('未知进路不能提交等待',
    () => inter.submitWaitingRequest('RX', { SW7: 'N' }, '甲'), 'ROUTE_NOT_FOUND');
  await expectThrow('缺失道岔选择拒绝',
    () => inter.submitWaitingRequest('R1', { SW8: 'N' }, '甲'), 'SWITCH_NOT_CHOSEN');
  await expectThrow('道岔选择与进路定义不符拒绝',
    () => inter.submitWaitingRequest('R1', { SW7: 'R', SW8: 'N' }, '甲'),
    'SWITCH_POSITION_MISMATCH');

  console.log('\n[2] 资源满足时提交即兑现（不预锁→直接成为实例）');
  const w0 = inter.submitWaitingRequest('R1', { SW7: 'N', SW8: 'N' }, '甲');
  ok('提交后状态为 fulfilled', w0.status === 'fulfilled');
  ok('兑现后带进入路实例编号', typeof w0.instanceId === 'number');
  ok('实例详情已带出且开放中', w0.instance && w0.instance.status === 'open');
  ok('实例锁定沿途资源', w0.instance.lockedSections.length === 3
    && w0.instance.lockedSwitches.length === 2);
  walkThrough(w0.instanceId, ['1', '3', '5'], '甲');

  console.log('\n[3] 资源不满足时进入等待，并记录阻断原因和顺位');
  const r1inst = inter.openRoute('R1', { SW7: 'N', SW8: 'N' }, '甲'); // 锁住 1/3/5、SW7/SW8(N)
  const wA = inter.submitWaitingRequest('R2', { SW7: 'N', SW8: 'R' }, '乙');
  ok('A 进入等待', wA.status === 'waiting');
  ok('A 顺位为 1', wA.queuePosition === 1);
  ok('A 阻断原因非空（锁闭/实际位置）',
    wA.blockReasons.some((r) => r.includes('锁') || r.includes('位置')));

  console.log('\n[4] FIFO：争用共享资源的后项不得越过仍有效的前项');
  const wB = inter.submitWaitingRequest('R2', { SW7: 'N', SW8: 'R' }, '丙');
  ok('B 进入等待且顺位 2', wB.status === 'waiting' && wB.queuePosition === 2);
  ok('B 阻断原因含"前项申请 #' + wA.id + '"排队提示',
    wB.blockReasons.some((r) => r.includes(`前项申请 #${wA.id}`)));

  console.log('\n[5] 资源互不相交者可先兑现（越过等待中的前项）');
  const wC = inter.submitWaitingRequest('R9', {}, '丁');
  ok('与 A/B 不相交的 R9 立即兑现', wC.status === 'fulfilled');
  const aStillWaiting = inter.getWaitingDetail(wA.id);
  ok('前项 A 仍在等待（未被后项影响）', aStillWaiting.status === 'waiting');
  walkThrough(wC.instanceId, ['9'], '丁');

  console.log('\n[6] 进路解除 + 道岔扳动触发自动兑现，后项仍不得越过');
  walkThrough(r1inst.id, ['1', '3', '5'], '甲'); // R1 解除，触发一次兑现（SW8 实际为 N，A 尚不能开）
  ok('R1 解除后 A 仍等待（SW8 实际 N ≠ 要求 R）',
    inter.getWaitingDetail(wA.id).status === 'waiting');
  const mv = inter.moveSwitch('SW8', 'R', '乙');          // 扳岔触发兑现
  ok('扳动道岔返回本批兑现列表含 A', mv.fulfilled.includes(wA.id));
  ok('A 已兑现', inter.getWaitingDetail(wA.id).status === 'fulfilled');
  const bAfterA = inter.getWaitingDetail(wB.id);
  ok('B 仍在等待（A 已持锁，不能越过）', bAfterA.status === 'waiting');
  ok('B 阻断原因为 A 所持锁',
    bAfterA.blockReasons.some((r) => r.includes('锁定')));

  console.log('\n[7] 前项走行完毕解除，自动兑现后项（重复触发只产生一个实例）');
  const aInstance = inter.getWaitingDetail(wA.id).instanceId;
  walkThrough(aInstance, ['1', '3', '4'], '乙');
  ok('A 解除后 B 自动兑现', inter.getWaitingDetail(wB.id).status === 'fulfilled');
  const instCountBefore = db.prepare(
    `SELECT COUNT(*) n FROM route_instances WHERE route_id='R2'`).get().n;
  inter.tryFulfillWaiting();
  inter.tryFulfillWaiting();
  const instCountAfter = db.prepare(
    `SELECT COUNT(*) n FROM route_instances WHERE route_id='R2'`).get().n;
  ok('重复触发不产生多个实例', instCountBefore === instCountAfter && instCountAfter === 2);
  walkThrough(inter.getWaitingDetail(wB.id).instanceId, ['1', '3', '4'], '丙');

  console.log('\n[8] 区段状态变化触发：未知区段清空后兑现');
  db.prepare(`INSERT INTO sections(id,label,x1,y1,x2,y2,occ_state)
              VALUES('10','10DG',0,0,1,1,'unknown')`).run();
  db.prepare(`INSERT INTO routes(id,label,origin,destination) VALUES('R10','未知区段进路','X10','X0')`).run();
  db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES('R10',1,'10')`).run();
  const wU = inter.submitWaitingRequest('R10', {}, '甲');
  ok('未知区段按占用 → 等待', wU.status === 'waiting'
    && wU.blockReasons.some((r) => r.includes('未知')));
  const clr = inter.setSectionState('10', 'clear', '甲');
  ok('核实清空返回兑现列表', clr.fulfilled.includes(wU.id));
  ok('清空后自动兑现', inter.getWaitingDetail(wU.id).status === 'fulfilled');
  walkThrough(inter.getWaitingDetail(wU.id).instanceId, ['10'], '甲');

  console.log('\n[9] 撤销权限：非本人 / 已兑现 拒绝；本人可撤销');
  const wMine = inter.submitWaitingRequest('R9', {}, '乙'); // 资源空闲 → 立即兑现
  db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id='1'`).run(); // 人为制造占用
  const wBlocked = inter.submitWaitingRequest('R2', { SW7: 'N', SW8: 'R' }, '乙');
  ok('构造一条等待申请', wBlocked.status === 'waiting');
  await expectThrow('非本人撤销拒绝',
    () => inter.cancelWaitingRequest(wBlocked.id, '丙'), 'NOT_OWNER');
  await expectThrow('已兑现申请不能撤销',
    () => inter.cancelWaitingRequest(wMine.id, '乙'), 'WAITING_NOT_ACTIVE');
  const canceled = inter.cancelWaitingRequest(wBlocked.id, '乙');
  ok('本人撤销成功', canceled.status === 'cancelled' && canceled.closeReason.includes('主动'));
  db.prepare(`UPDATE sections SET occ_state='free' WHERE id='1'`).run();

  console.log('\n[10] 撤销前项后后项可越过');
  db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id='1'`).run();
  const q1 = inter.submitWaitingRequest('R1', { SW7: 'N', SW8: 'N' }, '甲');
  const q2 = inter.submitWaitingRequest('R2', { SW7: 'N', SW8: 'R' }, '乙');
  ok('q2 被前项 q1 排队阻挡',
    inter.getWaitingDetail(q2.id).blockReasons.some((r) => r.includes(`前项申请 #${q1.id}`)));
  inter.cancelWaitingRequest(q1.id, '甲');
  db.prepare(`UPDATE sections SET occ_state='free' WHERE id='1'`).run();
  inter.tryFulfillWaiting(); // 触发兑现
  ok('q1 撤销后 q2 可兑现', inter.getWaitingDetail(q2.id).status === 'fulfilled');
  walkThrough(inter.getWaitingDetail(q2.id).instanceId, ['1', '3', '4'], '乙');

  console.log('\n[11] 进路定义变更/删除使申请失效并说明原因');
  const wEdit = inter.submitWaitingRequest('R1', { SW7: 'N', SW8: 'N' }, '甲');
  db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id='5'`).run(); // 先让其等待
  // 重新取状态确认 waiting（提交时 5 占用 → 等待）
  ok('编辑前申请在等待', inter.getWaitingDetail(wEdit.id).status === 'waiting');
  db.transaction(() => inter.invalidateWaitingForRouteTxn('R1', '进路 R1 定义已由管理员修改，原等待申请失效，请按新定义重新提交'))();
  const edited = inter.getWaitingDetail(wEdit.id);
  ok('编辑后进路申请失效', edited.status === 'invalidated');
  ok('失效原因已记录', edited.closeReason.includes('修改'));
  db.prepare(`UPDATE sections SET occ_state='free' WHERE id='5'`).run();

  const wDel = inter.submitWaitingRequest('R10', {}, '甲');
  ok('R10 申请提交（区段空闲应直接兑现，改测删除路径）', wDel.status === 'fulfilled');
  // 再造一条等待中的 R10 申请不可能（资源空闲即兑现），改为直接验证扫描兜底：
  db.prepare(`INSERT INTO waiting_requests(route_id,applicant,switch_positions,status)
              VALUES('GHOST','甲','{}','waiting')`).run();
  inter.tryFulfillWaiting();
  const ghost = db.prepare(`SELECT * FROM waiting_requests WHERE route_id='GHOST'`).get();
  ok('进路被删后扫描把悬挂申请置为失效', ghost.status === 'invalidated'
    && ghost.close_reason.includes('删除'));

  console.log('\n[12] 申请人退出 / 管理员重置 撤销等待申请');
  db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id='1'`).run();
  const wLogout = inter.submitWaitingRequest('R1', { SW7: 'N', SW8: 'N' }, '戊');
  const n = db.transaction(() => inter.cancelWaitingByApplicantTxn('戊', '申请人退出登录'))();
  ok('退出撤销本人申请', n === 1
    && inter.getWaitingDetail(wLogout.id).status === 'cancelled');
  inter.submitWaitingRequest('R2', { SW7: 'N', SW8: 'R' }, '己');
  const cn = db.transaction(() => inter.cancelAllWaitingTxn('管理员重置推演（清空推演状态），等待申请撤销'))();
  ok('管理员重置撤销全部等待（至少 1 条）', cn >= 1);
  ok('无剩余 waiting', db.prepare(`SELECT COUNT(*) n FROM waiting_requests WHERE status='waiting'`).get().n === 0);
  db.prepare(`UPDATE sections SET occ_state='free' WHERE id='1'`).run();

  console.log('\n[13] 状态快照含等待申请（刷新/重启可见）');
  const state = inter.getState();
  ok('快照含 waitingRequests', Array.isArray(state.waitingRequests) && state.waitingRequests.length >= 1);
  // 用 [9] 中已兑现且仍开放的 R9 申请验证：已兑现申请带实例快照
  const fulfilled = state.waitingRequests.find((w) => w.id === wMine.id);
  ok('快照中已兑现申请带实例快照',
    fulfilled && fulfilled.status === 'fulfilled' && fulfilled.instance
    && fulfilled.instance.id === fulfilled.instanceId);
  // 用 [13] 新提交（9 被占锁）验证等待态带顺位与阻断原因
  const wSnap = inter.submitWaitingRequest('R9', {}, '快照');
  ok('资源被前一实例占用 → 等待并带顺位',
    wSnap.status === 'waiting' && wSnap.queuePosition >= 1 && wSnap.blockReasons.length >= 1);
  const state2 = inter.getState();
  ok('刷新后的快照仍见等待申请及阻断原因',
    state2.waitingRequests.some((w) => w.id === wSnap.id && w.status === 'waiting'));

  console.log(`\n全部 ${passed} 项断言通过 ✅`);
  getDb().close();
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
