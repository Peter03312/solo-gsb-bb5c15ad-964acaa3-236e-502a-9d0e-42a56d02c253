'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const inter = require('../interlocking');
const { InterlockError } = require('../interlocking');

const router = express.Router();
router.use(requireAuth('dispatcher'));

function wrap(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

// 全量状态（刷新页面后恢复已提交状态）
router.get('/state', (req, res) => {
  res.json({ ok: true, state: inter.getState(), me: req.session.name });
});

// 预检：不产生任何锁
router.post('/routes/:id/check', wrap((req, res) => {
  const result = inter.checkOpen(req.params.id, req.body.switchPositions || {});
  res.json({ ok: true, check: result });
}));

// 开放进路（原子锁定）
router.post('/routes/:id/open', wrap((req, res) => {
  const detail = inter.openRoute(req.params.id, req.body.switchPositions || {}, req.session.name);
  res.json({ ok: true, instance: detail });
}));

// 扳动道岔（锁闭中拒绝）
router.post('/switches/:id/move', wrap((req, res) => {
  const position = String(req.body.position || '').toUpperCase();
  const result = inter.moveSwitch(req.params.id, position, req.session.name);
  res.json({ ok: true, result });
}));

// 排路前独立设置区段占用/清空（主要用于把"未知"核实为空闲）
router.post('/sections/:id/state', wrap((req, res) => {
  const action = String(req.body.action || '');
  if (!['occupy', 'clear'].includes(action)) {
    throw new InterlockError(400, 'BAD_ACTION', 'action 只能是 occupy 或 clear');
  }
  const result = inter.setSectionState(req.params.id, action, req.session.name);
  res.json({ ok: true, result });
}));

// 进路走行：按序号提交占用/清空事件
router.post('/instances/:id/events', wrap((req, res) => {
  const seq = Number(req.body.seq);
  const sectionId = String(req.body.sectionId || '');
  const action = String(req.body.action || '');
  if (!Number.isInteger(seq)) {
    throw new InterlockError(400, 'BAD_SEQ', `事件序号必须是整数（收到 ${req.body.seq}）`);
  }
  const result = inter.submitSectionEvent(
    Number(req.params.id), seq, sectionId, action, req.session.name
  );
  res.json({ ok: true, result });
}));

// 人工解除进路（末段未清空前拒绝）
router.post('/instances/:id/release', wrap((req, res) => {
  const detail = inter.releaseInstance(Number(req.params.id), req.session.name);
  res.json({ ok: true, instance: detail });
}));

/* ------------------------------ 等待申请 ------------------------------ */

// 等待申请列表（默认本人；?all=1 可看全班，含已兑现/失效/撤销记录）
router.get('/waiting', (req, res) => {
  const mine = req.query.all === '1' ? null : req.session.name;
  res.json({ ok: true, requests: inter.listWaitingRequests({ mine }) });
});

// 单条等待申请详情
router.get('/waiting/:id', wrap((req, res) => {
  const detail = inter.getWaitingDetail(Number(req.params.id));
  if (!detail) throw new InterlockError(404, 'WAITING_NOT_FOUND',
    `等待申请 ${req.params.id} 不存在`);
  res.json({ ok: true, request: detail });
}));

// 提交等待申请：不预锁资源，提交时即尝试兑现，之后随盘面变化自动重试
router.post('/routes/:id/wait', wrap((req, res) => {
  const positions = req.body.switchPositions;
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) {
    throw new InterlockError(400, 'BAD_SWITCH_POSITIONS',
      'switchPositions 必须为 {道岔号: "N"|"R"} 形式的对象');
  }
  const detail = inter.submitWaitingRequest(req.params.id, positions, req.session.name);
  res.json({
    ok: true,
    request: detail,
    // 已兑现时直接带上进路实例，便于调用方即时处理
    instance: detail.status === 'fulfilled' ? detail.instance : null
  });
}));

// 撤销本人未兑现的等待申请（非本人 / 非等待中均拒绝）
router.delete('/waiting/:id', wrap((req, res) => {
  const detail = inter.cancelWaitingRequest(Number(req.params.id), req.session.name);
  res.json({ ok: true, request: detail });
}));

module.exports = router;
