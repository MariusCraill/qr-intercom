const express = require('express');
const path = require('path');
const { getOne } = require('../db');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const router = express.Router();

router.get('/:gateId', (req, res) => {
  const gate = getOne('SELECT id FROM gates WHERE id = ?', [req.params.gateId]);
  if (!gate) return res.status(404).send('Gate not found');
  res.sendFile('gate.html', { root: PUBLIC_DIR });
});

module.exports = router;
