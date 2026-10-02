const express = require('express');
const { getOne } = require('../db');

const router = express.Router();

router.get('/:gateId', (req, res) => {
  const gate = getOne('SELECT * FROM gates WHERE id = ?', [req.params.gateId]);
  if (!gate) return res.status(404).send('Gate not found');
  res.sendFile('gate.html', { root: require('path').join(__dirname, '../../public') });
});

module.exports = router;
