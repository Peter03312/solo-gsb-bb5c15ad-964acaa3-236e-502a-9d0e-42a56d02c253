'use strict';

const express = require('express');
const { getDb } = require('../db');
const { adminPassword, createSession, destroySession, tokenOf, getSession } = require('../auth');
const inter = require('../interlocking');

const router = express.Router();

// 值班员登录：输入姓名即可
router.post('/login/dispatcher', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 1 || name.length > 30) {
    return res.status(400).json({ ok: false, error: '请输入值班员姓名（1~30 字）' });
  }
  const token = createSession('dispatcher', name);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, token, role: 'dispatcher', name });
});

// 管理员登录：固定口令
router.post('/login/admin', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== adminPassword()) {
    return res.status(401).json({ ok: false, error: '管理员口令不正确' });
  }
  const token = createSession('admin', '管理员');
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, token, role: 'admin', name: '管理员' });
});

router.post('/logout', (req, res) => {
  const token = tokenOf(req);
  const session = getSession(token);
  // 值班员退出：撤销其名下全部未兑现等待申请，并尝试兑现队中后续申请
  if (session && session.role === 'dispatcher') {
    getDb().transaction(() =>
      inter.cancelWaitingByApplicantTxn(session.name, '申请人退出登录'))();
  }
  destroySession(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

module.exports = router;
