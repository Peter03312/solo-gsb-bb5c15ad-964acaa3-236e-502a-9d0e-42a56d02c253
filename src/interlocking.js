'use strict';

/**
 * 核心联锁逻辑。
 *
 * 设计要点：
 *  - openRoute / moveSwitch / submitSectionEvent / 人工解除 都包在 better-sqlite3
 *    的单个事务里执行；事务内任何一处校验失败即 throw，事务自动回滚，
 *    因此"开放失败不会留下任何部分锁定"。
 *  - route_locks 上 (resource_type,resource_id) 的唯一约束是争用仲裁的最后防线：
 *    两名值班员并发开放冲突进路时，后到事务插入重复锁必然失败 → 整条回滚，
 *    只有一条进路能成功。
 *  - 区段占用状态 unknown 与 occupied 同等对待（未知按占用处理）。
 *  - 事件序号按进路实例严格递增：同号同内容重传幂等；同号异内容、跳号拒绝。
 */

const { getDb } = require('./db');

class InterlockError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------ 基础查询 ------------------------------ */

function getRoute(routeId) {
  const route = getDb().prepare(`SELECT * FROM routes WHERE id=?`).get(routeId);
  if (!route) throw new InterlockError(404, 'ROUTE_NOT_FOUND', `进路 ${routeId} 不存在`);
  return route;
}

function getRouteSteps(routeId) {
  return getDb()
    .prepare(`SELECT step_order, section_id FROM route_steps WHERE route_id=? ORDER BY step_order`)
    .all(routeId);
}

function getRouteSwitchReqs(routeId) {
  return getDb()
    .prepare(`SELECT switch_id, req_position FROM route_switch_reqs WHERE route_id=?`)
    .all(routeId);
}

function getInstance(instanceId) {
  const inst = getDb()
    .prepare(`SELECT * FROM route_instances WHERE id=? AND status='open'`)
    .get(instanceId);
  if (!inst) {
    throw new InterlockError(404, 'INSTANCE_NOT_FOUND',
      `进路实例 ${instanceId} 不存在或已解除`);
  }
  return inst;
}

/** 找到当前锁定了某资源的开放进路（用于争用原因提示） */
function lockingInstance(resourceType, resourceId) {
  return getDb()
    .prepare(
      `SELECT i.id, i.route_id, i.opened_by
         FROM route_locks l JOIN route_instances i ON i.id=l.instance_id
        WHERE l.resource_type=? AND l.resource_id=? AND i.status='open'`
    )
    .get(resourceType, resourceId);
}

/* --------------------------- 开放前预检（只读） --------------------------- */

/**
 * 预检某进路能否以给定道岔位置开放。
 * @param {string} routeId
 * @param {Object<string,'N'|'R'>} switchPositions 值班员选择的道岔位置
 *        （键为道岔号；未提供的要求道岔按"未选择/实际位置"参与判定）
 * @returns {{ok:boolean, reasons:Array, requirements:Object, signals:Array}}
 */
function checkOpen(routeId, switchPositions = {}) {
  const db = getDb();
  const route = db.prepare(`SELECT * FROM routes WHERE id=?`).get(routeId);
  const reasons = [];
  if (!route) {
    return {
      ok: false,
      reasons: [`进路 ${routeId} 不存在`],
      requirements: { sections: [], switches: [] },
      signals: []
    };
  }

  const steps = getRouteSteps(routeId);
  const reqs = getRouteSwitchReqs(routeId);

  if (steps.length === 0) reasons.push(`进路 ${routeId} 未定义任何区段，请先由管理员完善`);

  // 1) 沿途区段：未知/占用、已被其他开放进路锁定 → 阻断
  const sectionResults = steps.map((s) => {
    const sec = db.prepare(`SELECT id,label,occ_state FROM sections WHERE id=?`).get(s.section_id);
    const problems = [];
    if (!sec) {
      problems.push(`区段 ${s.section_id} 不存在（进路定义可能已失效）`);
    } else {
      if (sec.occ_state === 'occupied') problems.push(`区段 ${sec.id} 已被占用`);
      if (sec.occ_state === 'unknown') problems.push(`区段 ${sec.id} 占用状态未知，按占用处理`);
      const holder = lockingInstance('section', s.section_id);
      if (holder) {
        problems.push(`区段 ${s.section_id} 已被已开放进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`);
      }
    }
    if (problems.length) reasons.push(...problems);
    return { step: s.step_order, sectionId: s.section_id,
      state: sec ? sec.occ_state : 'missing', problems };
  });

  // 2) 道岔：值班员选择位置必须与进路要求一致；与实际位置不符时提示先扳动；
  //    已被其他进路锁定（即使要求位置恰好相同）也不能再锁 → 阻断
  const switchResults = reqs.map((r) => {
    const sw = db.prepare(`SELECT id,label,position FROM switches WHERE id=?`).get(r.switch_id);
    const chosen = switchPositions[r.switch_id] || null;
    const problems = [];
    if (!sw) {
      problems.push(`道岔 ${r.switch_id} 不存在（进路定义可能已失效）`);
    } else {
      if (!chosen) {
        problems.push(`道岔 ${sw.id} 未选择所需位置（进路要求 ${r.req_position}）`);
      } else if (chosen !== r.req_position) {
        problems.push(`道岔 ${sw.id} 所选位置 ${chosen} 与进路要求 ${r.req_position} 不符`);
      }
      if (sw && sw.position !== r.req_position) {
        problems.push(`道岔 ${sw.id} 实际位置为 ${sw.position}，需先扳至 ${r.req_position}`);
      }
      const holder = lockingInstance('switch', r.switch_id);
      if (holder) {
        problems.push(`道岔 ${r.switch_id} 已被已开放进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`);
      }
    }
    if (problems.length) reasons.push(...problems);
    return { switchId: r.switch_id, required: r.req_position,
      chosen, actual: sw ? sw.position : null, problems };
  });

  const entrySignal = route.entry_signal_id
    ? db.prepare(`SELECT * FROM signals WHERE id=?`).get(route.entry_signal_id)
    : null;

  return {
    ok: reasons.length === 0,
    reasons,
    requirements: {
      sections: sectionResults,
      switches: switchResults,
      entrySignal: entrySignal ? { id: entrySignal.id, label: entrySignal.label } : null
    },
    // 预检通过时信号将显示绿灯，否则红灯
    signalPreview: reasons.length === 0 ? 'green' : 'red'
  };
}

/* ------------------------------ 开放进路 ------------------------------ */

/**
 * 开放进路：事务内完成 定义校验→区段占用/锁定校验→道岔选择/实际/锁定校验
 * →写实例→写全部区段/道岔锁→入口信号转绿。任何一步失败整体回滚。
 */
function openRoute(routeId, switchPositions, clientName) {
  const db = getDb();
  const instanceId = db.transaction(() =>
    openRouteTxn(routeId, switchPositions, clientName))();
  return getInstanceDetail(instanceId);
}

/**
 * openRoute 的事务体（自身不开事务），便于"等待申请兑现"在同一外层事务内
 * 经 SAVEPOINT 调用：单个申请兑现失败只回滚到保存点，不影响同批其他申请。
 * 复用此处即保证"等待兑现"与"直接开放"走完全相同的校验与锁闭逻辑。
 */
function openRouteTxn(routeId, switchPositions, clientName) {
  const db = getDb();
  const route = getRoute(routeId);
  const steps = getRouteSteps(routeId);
  const reqs = getRouteSwitchReqs(routeId);
  if (steps.length === 0) {
    throw new InterlockError(400, 'EMPTY_ROUTE', `进路 ${routeId} 未定义区段，无法开放`);
  }

  // 区段校验
  for (const s of steps) {
    const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(s.section_id);
    if (!sec) throw new InterlockError(400, 'SECTION_MISSING',
      `进路定义中的区段 ${s.section_id} 不存在，请通知管理员检查进路 ${routeId}`,
      { sectionId: s.section_id });
    if (sec.occ_state === 'occupied') {
      throw new InterlockError(409, 'SECTION_OCCUPIED',
        `不能开放：区段 ${s.section_id} 已被占用`, { sectionId: s.section_id });
    }
    if (sec.occ_state === 'unknown') {
      throw new InterlockError(409, 'SECTION_UNKNOWN',
        `不能开放：区段 ${s.section_id} 占用状态未知，按占用处理；请先核实并提交清空`,
        { sectionId: s.section_id });
    }
    const holder = lockingInstance('section', s.section_id);
    if (holder) {
      throw new InterlockError(409, 'RESOURCE_LOCKED',
        `不能开放：区段 ${s.section_id} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`,
        { sectionId: s.section_id, holder: holder.id });
    }
  }

  // 道岔校验
  for (const r of reqs) {
    const sw = db.prepare(`SELECT position FROM switches WHERE id=?`).get(r.switch_id);
    if (!sw) throw new InterlockError(400, 'SWITCH_MISSING',
      `进路定义中的道岔 ${r.switch_id} 不存在`, { switchId: r.switch_id });
    const chosen = (switchPositions || {})[r.switch_id];
    if (!chosen) {
      throw new InterlockError(400, 'SWITCH_NOT_CHOSEN',
        `不能开放：道岔 ${r.switch_id} 未选择所需位置（进路要求 ${r.req_position}）`,
        { switchId: r.switch_id, required: r.req_position });
    }
    if (chosen !== r.req_position) {
      throw new InterlockError(409, 'SWITCH_POSITION_MISMATCH',
        `不能开放：道岔 ${r.switch_id} 选择位置 ${chosen} 与进路要求 ${r.req_position} 不符`,
        { switchId: r.switch_id, chosen, required: r.req_position });
    }
    if (sw.position !== r.req_position) {
      throw new InterlockError(409, 'SWITCH_ACTUAL_MISMATCH',
        `不能开放：道岔 ${r.switch_id} 实际位置为 ${sw.position}，与进路要求 ${r.req_position} 不符，请先扳道岔`,
        { switchId: r.switch_id, actual: sw.position, required: r.req_position });
    }
    const holder = lockingInstance('switch', r.switch_id);
    if (holder) {
      throw new InterlockError(409, 'RESOURCE_LOCKED',
        `不能开放：道岔 ${r.switch_id} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`,
        { switchId: r.switch_id, holder: holder.id });
    }
  }

  // 建立进路实例（信号初始绿灯 = 允许车列进入）
  const info = db
    .prepare(`INSERT INTO route_instances(route_id,opened_by,status,signal_state,next_seq,head_step,tail_step)
              VALUES(?,?, 'open','green',1,1,1)`)
    .run(routeId, clientName);
  const instanceId = info.lastInsertRowid;

  const insLock = db.prepare(
    `INSERT INTO route_locks(instance_id,resource_type,resource_id,step_order) VALUES(?,?,?,?)`
  );
  try {
    for (const s of steps) insLock.run(instanceId, 'section', s.section_id, s.step_order);
    for (const r of reqs) insLock.run(instanceId, 'switch', r.switch_id, null);
  } catch (e) {
    // 唯一约束冲突 = 并发争用仲裁失败；外层事务将整体回滚，无部分锁定
    if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new InterlockError(409, 'CONTENTION_LOST',
        `开放失败：与并发申请的进路争用资源，本进路未获得锁（请刷新后重试）`,
        { contention: true });
    }
    throw e;
  }

  return instanceId;
}

/* ------------------------------ 扳动道岔 ------------------------------ */

/** 扳动未锁闭道岔。被任意开放进路锁定的道岔拒绝。 */
function moveSwitch(switchId, targetPosition, clientName) {
  if (!['N', 'R'].includes(targetPosition)) {
    throw new InterlockError(400, 'BAD_POSITION', `道岔位置只能是 N(定位) 或 R(反位)`);
  }
  const db = getDb();
  const result = db.transaction(() => {
    const sw = db.prepare(`SELECT * FROM switches WHERE id=?`).get(switchId);
    if (!sw) throw new InterlockError(404, 'SWITCH_NOT_FOUND', `道岔 ${switchId} 不存在`);
    const holder = lockingInstance('switch', switchId);
    if (holder) {
      throw new InterlockError(409, 'SWITCH_LOCKED',
        `道岔 ${switchId} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁闭，不能扳动`,
        { switchId, holder: holder.id });
    }
    db.prepare(`UPDATE switches SET position=? WHERE id=?`).run(targetPosition, switchId);
    // 道岔实际位置变化：同事务内尝试兑现等待申请
    const sweep = tryFulfillWaitingTxn();
    return { switchId, position: targetPosition, by: clientName, fulfilled: sweep.fulfilled };
  })();
  return result;
}

/* ------------------------ 独立区段占用/清空（排路前） ------------------------ */

/**
 * 不依附进路实例的区段事件：用于把"未知"区段核实为空闲（清空），
 * 或培训时手工设置占用。未知状态按占用处理，因此新建区段必须先清空才能排路。
 */
function setSectionState(sectionId, action, clientName) {
  const db = getDb();
  const result = db.transaction(() => {
    const sec = db.prepare(`SELECT * FROM sections WHERE id=?`).get(sectionId);
    if (!sec) throw new InterlockError(404, 'SECTION_NOT_FOUND', `区段 ${sectionId} 不存在`);
    const holder = lockingInstance('section', sectionId);
    if (holder && action === 'clear') {
      throw new InterlockError(409, 'SECTION_LOCKED',
        `区段 ${sectionId} 在进路 #${holder.id} 锁闭中，清空请按该进路的事件序号提交`,
        { sectionId, holder: holder.id });
    }
    const state = action === 'occupy' ? 'occupied' : 'free';
    db.prepare(`UPDATE sections SET occ_state=? WHERE id=?`).run(state, sectionId);
    // 区段状态变化（核实空闲等）：同事务内尝试兑现等待申请
    const sweep = tryFulfillWaitingTxn();
    return { sectionId, occState: state, by: clientName, fulfilled: sweep.fulfilled };
  })();
  return result;
}

/* --------------------------- 进路走行事件（序号） --------------------------- */

/**
 * 按进路实例提交占用/清空事件。
 * 规则：
 *  - seq 必须等于实例 next_seq（严格递增）；小则重传，大则跳号。
 *  - 同号同内容：幂等成功，不重复生效；同号异内容：拒绝。
 *  - 占用：只能作用于"当前可进入区段" head_step；首段被占用 → 信号回红。
 *  - 清空：只能作用于"当前最早未出清区段" tail_step；清空后删除该区段锁（逐段解锁）；
 *    清空末段后整条进路自动解除（实例 released，道岔锁随之释放）。
 */
function submitSectionEvent(instanceId, seq, sectionId, action, clientName) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new InterlockError(400, 'BAD_SEQ', `事件序号必须是从 1 开始的正整数（收到 ${seq}）`);
  }
  if (!['occupy', 'clear'].includes(action)) {
    throw new InterlockError(400, 'BAD_ACTION', `事件类型只能是 occupy(占用) 或 clear(清空)`);
  }

  const db = getDb();
  const txn = db.transaction(() => {
    const inst = getInstance(instanceId);
    const steps = getRouteSteps(inst.route_id);
    const lastStep = steps.length;

    // 1) 序号校验（幂等 / 冲突 / 跳号）
    const existing = db.prepare(
      `SELECT seq, section_id, action FROM section_events WHERE instance_id=? AND seq=?`
    ).get(instanceId, seq);

    if (existing) {
      if (existing.section_id === sectionId && existing.action === action) {
        return { idempotent: true, instanceId, seq, sectionId, action };
      }
      throw new InterlockError(409, 'SEQ_CONFLICT',
        `序号 ${seq} 已用于 ${existing.action === 'occupy' ? '占用' : '清空'} 区段 ${existing.section_id}，` +
        `不能再提交为${action === 'occupy' ? '占用' : '清空'}区段 ${sectionId}（同号异内容拒绝）`,
        { seq, existing, received: { sectionId, action } });
    }
    if (seq < inst.next_seq) {
      // 理论上上面已命中历史事件，兜底
      throw new InterlockError(409, 'SEQ_CONFLICT', `序号 ${seq} 已使用（同号异内容）`);
    }
    if (seq > inst.next_seq) {
      throw new InterlockError(409, 'SEQ_GAP',
        `跳号拒绝：期望下一个序号为 ${inst.next_seq}，收到 ${seq}（涉及区段 ${sectionId}）`,
        { expectedSeq: inst.next_seq, receivedSeq: seq, sectionId });
    }

    // 2) 区段归属校验
    const step = steps.find((s) => s.section_id === sectionId);
    if (!step) {
      throw new InterlockError(400, 'SECTION_NOT_IN_ROUTE',
        `区段 ${sectionId} 不属于进路 ${inst.route_id}（实例 #${instanceId}）的经过区段`,
        { sectionId, routeId: inst.route_id });
    }

    // 3) 走行顺序校验 + 状态变更
    if (action === 'occupy') {
      if (step.step_order !== inst.head_step) {
        throw new InterlockError(409, 'OUT_OF_ORDER',
          `占用顺序不符：当前应进入第 ${inst.head_step} 个区段 ${steps[inst.head_step - 1].section_id}，` +
          `收到的是第 ${step.step_order} 个区段 ${sectionId}`,
          { sectionId, expectedSection: steps[inst.head_step - 1].section_id });
      }
      db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id=?`).run(sectionId);
      db.prepare(
        `INSERT INTO section_events(instance_id,seq,section_id,action,client) VALUES(?,?,?,?,?)`
      ).run(instanceId, seq, sectionId, action, clientName);

      const updates = ['next_seq = next_seq + 1', 'head_step = head_step + 1'];
      // 列车进入首段 → 入口信号回红
      if (step.step_order === 1) updates.push(`signal_state='red'`);
      db.prepare(`UPDATE route_instances SET ${updates.join(', ')} WHERE id=?`).run(instanceId);

      // 区段变为占用：同事务内尝试兑现（占用通常只会使后续申请继续等待）
      const sweep = tryFulfillWaitingTxn();
      return { idempotent: false, instanceId, seq, sectionId, action,
        signalTurnedRed: step.step_order === 1, fulfilled: sweep.fulfilled };
    }

    // action === 'clear'
    if (step.step_order !== inst.tail_step) {
      throw new InterlockError(409, 'OUT_OF_ORDER',
        `清空顺序不符：当前应先出清第 ${inst.tail_step} 个区段 ${steps[inst.tail_step - 1].section_id}，` +
        `不能提前清空第 ${step.step_order} 个区段 ${sectionId}（须按走行方向逐段解锁）`,
        { sectionId, expectedSection: steps[inst.tail_step - 1].section_id });
    }
    const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(sectionId);
    if (sec.occ_state !== 'occupied') {
      throw new InterlockError(409, 'NOT_OCCUPIED',
        `区段 ${sectionId} 当前并非占用状态（${sec.occ_state === 'unknown' ? '未知' : '空闲'}），不能提交清空事件`,
        { sectionId, state: sec.occ_state });
    }

    db.prepare(`UPDATE sections SET occ_state='free' WHERE id=?`).run(sectionId);
    db.prepare(
      `INSERT INTO section_events(instance_id,seq,section_id,action,client) VALUES(?,?,?,?,?)`
    ).run(instanceId, seq, sectionId, action, clientName);
    // 逐段解锁：删除该区段锁
    db.prepare(
      `DELETE FROM route_locks WHERE instance_id=? AND resource_type='section' AND resource_id=?`
    ).run(instanceId, sectionId);

    if (step.step_order === lastStep) {
      // 末段已清空 → 整条进路解除（道岔锁随实例删除，保留实例/事件记录供复盘）
      db.prepare(
        `UPDATE route_instances SET status='released', signal_state='red',
                next_seq=next_seq+1, tail_step=tail_step+1, released_at=datetime('now')
         WHERE id=?`
      ).run(instanceId);
      db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(instanceId);
      // 进路解除、资源释放：同事务内尝试兑现等待申请（关键触发点）
      const sweep = tryFulfillWaitingTxn();
      return { idempotent: false, instanceId, seq, sectionId, action, routeReleased: true,
        fulfilled: sweep.fulfilled };
    }

    db.prepare(
      `UPDATE route_instances SET next_seq=next_seq+1, tail_step=tail_step+1 WHERE id=?`
    ).run(instanceId);
    // 区段清空解锁：同事务内尝试兑现等待申请
    const sweep = tryFulfillWaitingTxn();
    return { idempotent: false, instanceId, seq, sectionId, action, sectionUnlocked: true,
      fulfilled: sweep.fulfilled };
  });

  const result = txn();
  result.detail = getInstanceDetail(instanceId, true);
  return result;
}

/* ------------------------------ 人工解除进路 ------------------------------ */

/**
 * 值班员请求提前解除进路。联锁规则：末段未清空前不得解除整条进路。
 * 正常走行完毕时系统会在末段清空后自动解除，无需调用本接口。
 */
function releaseInstance(instanceId, clientName) {
  const db = getDb();
  const txn = db.transaction(() => {
    const inst = getInstance(instanceId);
    const steps = getRouteSteps(inst.route_id);
    const lastStep = steps.length;
    const lastSection = steps[lastStep - 1].section_id;
    const lock = db.prepare(
      `SELECT 1 FROM route_locks WHERE instance_id=? AND resource_type='section' AND resource_id=?`
    ).get(instanceId, lastSection);
    if (lock) {
      throw new InterlockError(409, 'LAST_SECTION_NOT_CLEARED',
        `不能解除：末段区段 ${lastSection} 尚未清空（须按序提交占用/清空事件，末段清空后进路自动解除）`,
        { lastSection });
    }
    // 末段锁已不存在说明走行已完成，正常应已自动 released；此处兜底完成解除
    db.prepare(
      `UPDATE route_instances SET status='released', released_at=datetime('now') WHERE id=?`
    ).run(instanceId);
    db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(instanceId);
    // 资源释放：同事务内尝试兑现等待申请
    tryFulfillWaitingTxn();
  });
  txn();
  return getInstanceDetail(instanceId, true);
}

/* ============================ 等待申请（排队排路） ============================
 *
 * 值班员可对某进路提交"等待申请"：提交时只校验进路存在与道岔选择合法，
 * 不预锁任何资源。系统在以下时机自动尝试兑现（同事务内重跑开放校验与锁闭）：
 * 提交时、区段状态变化、道岔扳动、走行清空/进路解除、服务重启。
 *
 * 排队规则（按申请编号 id 的提交先后，即 FIFO）：
 *  - 后项与"仍有效的前项未兑现申请"争用共享区段/道岔时，不得越过前项；
 *  - 资源与前项互不相交者可先行兑现（并行进路）。
 *  - 兑现复用 openRouteTxn：区段未知/占用、道岔实际不符、被他路锁闭时继续等待，
 *    重复触发幂等，一个申请最多产生一个进路实例。
 */

function parseSwitchPositions(raw) {
  let obj = {};
  try { obj = JSON.parse(raw || '{}'); } catch (_) { obj = {}; }
  return obj && typeof obj === 'object' ? obj : {};
}

function getWaitingRow(id) {
  return getDb().prepare(`SELECT * FROM waiting_requests WHERE id=?`).get(Number(id));
}

/** 等待申请详情（含顺位、阻断原因、兑现实例快照），供接口与状态快照使用 */
function getWaitingDetail(id) {
  const db = getDb();
  const row = (typeof id === 'object' && id !== null) ? id : getWaitingRow(id);
  if (!row) return null;
  let reasons = [];
  try { reasons = JSON.parse(row.block_reasons || '[]'); } catch (_) { reasons = []; }

  let queuePosition = null;
  if (row.status === 'waiting') {
    // 顺位：所有仍有效（waiting）申请中的提交序号
    queuePosition = db.prepare(
      `SELECT COUNT(*) AS n FROM waiting_requests WHERE status='waiting' AND id <= ?`
    ).get(row.id).n;
  }

  let instance = null;
  if (row.instance_id) instance = getInstanceDetail(row.instance_id, true);

  return {
    id: row.id,
    routeId: row.route_id,
    applicant: row.applicant,
    switchPositions: parseSwitchPositions(row.switch_positions),
    status: row.status,
    blockReasons: reasons,
    queuePosition,
    instanceId: row.instance_id,
    instance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason
  };
}

/**
 * 提交等待申请（事务）：
 *  - 进路必须存在且已定义区段；
 *  - 进路要求的每个道岔都必须给出选择，且选择值必须与进路定义一致
 *    （道岔/区段的"实际位置、占用、锁闭"不在提交时拦截，留待兑现时重验）；
 *  - 提交后在同一事务内立即尝试兑现。
 */
function submitWaitingRequest(routeId, switchPositions, clientName) {
  const db = getDb();
  return db.transaction(() => {
    const route = getRoute(routeId);
    const steps = getRouteSteps(routeId);
    const reqs = getRouteSwitchReqs(routeId);
    if (steps.length === 0) {
      throw new InterlockError(400, 'EMPTY_ROUTE', `进路 ${routeId} 未定义区段，无法提交申请`);
    }
    const positions = switchPositions && typeof switchPositions === 'object' ? switchPositions : {};
    for (const r of reqs) {
      const chosen = positions[r.switch_id];
      if (!chosen) {
        throw new InterlockError(400, 'SWITCH_NOT_CHOSEN',
          `等待申请被拒：道岔 ${r.switch_id} 未选择所需位置（进路要求 ${r.req_position}）`,
          { switchId: r.switch_id, required: r.req_position });
      }
      if (!['N', 'R'].includes(chosen)) {
        throw new InterlockError(400, 'BAD_POSITION',
          `等待申请被拒：道岔 ${r.switch_id} 选择值 ${chosen} 非法（只能是 N 或 R）`,
          { switchId: r.switch_id });
      }
      if (chosen !== r.req_position) {
        throw new InterlockError(409, 'SWITCH_POSITION_MISMATCH',
          `等待申请被拒：道岔 ${r.switch_id} 选择位置 ${chosen} 与进路定义要求 ${r.req_position} 不符`,
          { switchId: r.switch_id, chosen, required: r.req_position });
      }
    }

    const info = db.prepare(
      `INSERT INTO waiting_requests(route_id,applicant,switch_positions,status,block_reasons)
       VALUES(?,?,?, 'waiting','[]')`
    ).run(routeId, clientName, JSON.stringify(positions));

    // 提交即尝试兑现（不预锁资源；资源满足时立即成为进路实例）
    tryFulfillWaitingTxn();
    return getWaitingDetail(info.lastInsertRowid);
  })();
}

/**
 * 撤销等待申请（事务）。仅本人且申请仍在等待中可撤销；
 * 已兑现/已失效/已撤销，或非本人操作一律拒绝。
 */
function cancelWaitingRequest(id, clientName) {
  const db = getDb();
  return db.transaction(() => {
    const row = getWaitingRow(id);
    if (!row) throw new InterlockError(404, 'WAITING_NOT_FOUND', `等待申请 ${id} 不存在`);
    if (row.applicant !== clientName) {
      throw new InterlockError(403, 'NOT_OWNER',
        `不能撤销：申请 #${id} 属于值班员 ${row.applicant}，仅本人可撤销`);
    }
    if (row.status !== 'waiting') {
      throw new InterlockError(409, 'WAITING_NOT_ACTIVE',
        `申请 #${id} 当前状态为 ${waitingStatusText(row.status)}，不能撤销`, { status: row.status });
    }
    db.prepare(
      `UPDATE waiting_requests SET status='cancelled', closed_at=datetime('now'),
              close_reason='申请人主动撤销', updated_at=datetime('now') WHERE id=?`
    ).run(id);
    // 前项撤销后，后项可能可越过 → 同事务重试兑现
    tryFulfillWaitingTxn();
    return getWaitingDetail(id);
  })();
}

/**
 * 撤销某值班员名下全部等待申请（退出登录时调用）。
 * 纯内部函数，不校验身份（调用方已由会话鉴权确定本人）。
 */
function cancelWaitingByApplicantTxn(clientName, reason = '申请人退出登录') {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id FROM waiting_requests WHERE applicant=? AND status='waiting'`
  ).all(clientName);
  for (const r of rows) {
    db.prepare(
      `UPDATE waiting_requests SET status='cancelled', closed_at=datetime('now'),
              close_reason=?, updated_at=datetime('now') WHERE id=?`
    ).run(reason, r.id);
  }
  // 退出者的申请让出队位，同事务尝试兑现其后的申请
  if (rows.length) tryFulfillWaitingTxn();
  return rows.length;
}

/**
 * 使引用某进路的全部等待申请失效（管理员修改/删除进路定义时，在其事务内调用）。
 * @returns 受影响条数
 */
function invalidateWaitingForRouteTxn(routeId, reason) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id FROM waiting_requests WHERE route_id=? AND status='waiting'`
  ).all(routeId);
  for (const r of rows) {
    db.prepare(
      `UPDATE waiting_requests SET status='invalidated', closed_at=datetime('now'),
              close_reason=?, block_reasons='[]', updated_at=datetime('now') WHERE id=?`
    ).run(reason, r.id);
  }
  return rows.length;
}

/** 管理员重置推演：撤销全部等待申请（在其事务内调用）。 */
function cancelAllWaitingTxn(reason) {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM waiting_requests WHERE status='waiting'`).all();
  for (const r of rows) {
    db.prepare(
      `UPDATE waiting_requests SET status='cancelled', closed_at=datetime('now'),
              close_reason=?, block_reasons='[]', updated_at=datetime('now') WHERE id=?`
    ).run(reason, r.id);
  }
  return rows.length;
}

function waitingStatusText(status) {
  return ({ waiting: '等待中', fulfilled: '已兑现', invalidated: '已失效', cancelled: '已撤销' })[status]
    || status;
}

/** 两个进路的资源（区段+道岔）是否相交 */
function routesOverlap(a, b) {
  for (const sid of a.sections) if (b.sections.has(sid)) return true;
  for (const sw of a.switches) if (b.switches.has(sw)) return true;
  return false;
}

/**
 * 尝试兑现全部等待申请（核心）。
 *
 * 本函数为"事务体"：必须在 better-sqlite3 事务中调用（各触发点已在事务内；
 * 服务重启等无外层事务的场景使用 tryFulfillWaiting() 包装）。
 *
 * 单趟扫描所有 waiting 申请（按 id 升序）：
 *  1) 进路定义已不存在 → 置 invalidated；
 *  2) 与任一"仍有效的前项未兑现申请"资源相交 → 排队阻断，不尝试锁闭；
 *  3) 否则在 SAVEPOINT 内复用 openRouteTxn 重新执行完整开放校验与锁闭：
 *     成功 → fulfilled 并挂上进路实例；失败 → 仅回滚保存点，刷新阻断原因，继续等待。
 * 一个申请最多兑现一次，重复触发不会产生多个实例。
 */
function tryFulfillWaitingTxn() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM waiting_requests WHERE status='waiting' ORDER BY id`
  ).all();
  if (rows.length === 0) return { fulfilled: [], stillWaiting: 0 };

  // 当前进路定义资源缓存（同批内定义不会变化）
  const defCache = new Map();
  function routeDef(routeId) {
    if (defCache.has(routeId)) return defCache.get(routeId);
    const exists = db.prepare(`SELECT 1 FROM routes WHERE id=?`).get(routeId);
    let def = null;
    if (exists) {
      def = {
        sections: new Set(getRouteSteps(routeId).map((s) => s.section_id)),
        switches: new Set(getRouteSwitchReqs(routeId).map((r) => r.switch_id))
      };
    }
    defCache.set(routeId, def);
    return def;
  }

  // 本趟扫描中仍有效的前项（waiting）申请：初始为全部在队申请
  const activeEarlier = [];
  const fulfilledIds = [];

  const saveReasons = db.prepare(
    `UPDATE waiting_requests SET block_reasons=?, updated_at=datetime('now') WHERE id=?`
  );
  const markFulfilled = db.prepare(
    `UPDATE waiting_requests SET status='fulfilled', instance_id=?, block_reasons='[]',
            closed_at=datetime('now'), close_reason='资源满足，自动兑现开放',
            updated_at=datetime('now') WHERE id=?`
  );
  const markInvalidated = db.prepare(
    `UPDATE waiting_requests SET status='invalidated', block_reasons='[]',
            closed_at=datetime('now'), close_reason=?, updated_at=datetime('now') WHERE id=?`
  );

  // 嵌套事务（SAVEPOINT）：单个申请兑现失败只回滚该申请的写入
  const attemptInSavepoint = db.transaction((row) =>
    openRouteTxn(row.route_id, parseSwitchPositions(row.switch_positions), row.applicant));

  for (const row of rows) {
    const def = routeDef(row.route_id);
    if (!def) {
      markInvalidated.run(`进路 ${row.route_id} 定义已被删除，等待申请失效`, row.id);
      continue;
    }

    // 队列规则：与仍有效的前项未兑现申请争用资源 → 不得越过
    const blockers = activeEarlier.filter((e) => routesOverlap(e.def, def));
    if (blockers.length > 0) {
      // 同时给出本申请按当前盘面自身的阻断原因，便于值班员预判
      const own = checkOpen(row.route_id, parseSwitchPositions(row.switch_positions));
      const queueReasons = blockers.map((b) =>
        `排队等待：前项申请 #${b.row.id}（${b.row.route_id}，${b.row.applicant}）尚未兑现且与本申请争用资源，不得越过`);
      const reasons = [...new Set([...queueReasons, ...own.reasons])];
      saveReasons.run(JSON.stringify(reasons), row.id);
      activeEarlier.push({ row, def });
      continue;
    }

    // 无前项阻挡 → 同事务（保存点）内重新执行开放校验与锁闭
    try {
      const instanceId = attemptInSavepoint(row);
      markFulfilled.run(instanceId, row.id);
      fulfilledIds.push(row.id);
      // 已兑现不再阻挡后项（其锁会在后续申请的开放校验中按"他路锁闭"正常仲裁）
    } catch (e) {
      // 定义本身已损坏（区段/道岔缺失、进路无区段）→ 不可能再兑现，置失效
      if (['SECTION_MISSING', 'SWITCH_MISSING', 'EMPTY_ROUTE'].includes(e.code)) {
        markInvalidated.run(
          `进路 ${row.route_id} 定义已失效（${e.message}），等待申请失效`, row.id);
        continue;
      }
      // 兑现条件不满足（占用/未知/位置不符/他路锁闭）：刷新阻断原因，继续等待
      const reasons = e && e.message ? [e.message] : ['兑现条件暂不满足，继续等待'];
      saveReasons.run(JSON.stringify(reasons), row.id);
      activeEarlier.push({ row, def });
    }
  }

  const stillWaiting = db.prepare(
    `SELECT COUNT(*) AS n FROM waiting_requests WHERE status='waiting'`
  ).get().n;
  return { fulfilled: fulfilledIds, stillWaiting };
}

/** 无外层事务场景（如服务重启）使用：整体包一层事务。 */
function tryFulfillWaiting() {
  return getDb().transaction(() => tryFulfillWaitingTxn())();
}

/** 列出等待申请：默认全部（含已兑现/失效/撤销，刷新与重启后可见） */
function listWaitingRequests({ mine = null } = {}) {
  const db = getDb();
  const rows = mine
    ? db.prepare(`SELECT * FROM waiting_requests WHERE applicant=? ORDER BY id DESC`).all(mine)
    : db.prepare(`SELECT * FROM waiting_requests ORDER BY id DESC`).all();
  return rows.map((r) => getWaitingDetail(r));
}

/* ------------------------------ 状态快照 ------------------------------ */

function getInstanceDetail(instanceId, includeReleased = false) {
  const db = getDb();
  const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(instanceId);
  if (!inst || (inst.status !== 'open' && !includeReleased)) return null;
  if (!inst) return null;
  const steps = getRouteSteps(inst.route_id);
  const reqs = getRouteSwitchReqs(inst.route_id);
  const locks = db.prepare(
    `SELECT resource_type, resource_id, step_order FROM route_locks WHERE instance_id=?`
  ).all(instanceId);
  const events = db.prepare(
    `SELECT seq, section_id, action, client, created_at FROM section_events
      WHERE instance_id=? ORDER BY seq`
  ).all(instanceId);
  return {
    id: inst.id,
    routeId: inst.route_id,
    openedBy: inst.opened_by,
    status: inst.status,
    signalState: inst.signal_state,
    nextSeq: inst.next_seq,
    headStep: inst.head_step,
    tailStep: inst.tail_step,
    createdAt: inst.created_at,
    releasedAt: inst.released_at,
    sections: steps,
    switchReqs: reqs,
    lockedSections: locks.filter((l) => l.resource_type === 'section').map((l) => l.resource_id),
    lockedSwitches: locks.filter((l) => l.resource_type === 'switch').map((l) => l.resource_id),
    events
  };
}

/** 全量状态：前端刷新后据此恢复全部已提交状态 */
function getState() {
  const db = getDb();
  const sections = db.prepare(`SELECT * FROM sections ORDER BY id`).all();
  const switches = db.prepare(`SELECT * FROM switches ORDER BY id`).all();
  const signals = db.prepare(`SELECT * FROM signals ORDER BY id`).all();
  const routes = db.prepare(`SELECT * FROM routes ORDER BY id`).all().map((r) => ({
    ...r,
    steps: getRouteSteps(r.id),
    switchReqs: getRouteSwitchReqs(r.id)
  }));
  const openInstances = db.prepare(
    `SELECT id FROM route_instances WHERE status='open' ORDER BY id`
  ).all().map((r) => getInstanceDetail(r.id));
  const recentReleased = db.prepare(
    `SELECT id FROM route_instances WHERE status='released' ORDER BY id DESC LIMIT 20`
  ).all().map((r) => getInstanceDetail(r.id, true));

  // 等待申请（含等待中/已兑现/已失效/已撤销），状态刷新与重启后均可见
  const waitingRequests = listWaitingRequests({}).slice(0, 200);

  return {
    serverTime: new Date().toISOString(),
    sections,
    switches,
    signals,
    routes,
    openInstances,
    recentReleased,
    waitingRequests
  };
}

module.exports = {
  InterlockError,
  checkOpen,
  openRoute,
  moveSwitch,
  setSectionState,
  submitSectionEvent,
  releaseInstance,
  getState,
  getInstanceDetail,
  // 等待申请
  submitWaitingRequest,
  cancelWaitingRequest,
  listWaitingRequests,
  getWaitingDetail,
  tryFulfillWaiting,
  // 供其他路由在自己的事务内组合调用（事务体，勿在事务外直接调用）
  tryFulfillWaitingTxn,
  cancelWaitingByApplicantTxn,
  invalidateWaitingForRouteTxn,
  cancelAllWaitingTxn
};
