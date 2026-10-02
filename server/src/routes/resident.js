const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.sendFile('resident.html', { root: require('path').join(__dirname, '../../public') });
});

router.get('/:callId', (req, res) => {
  res.sendFile('resident.html', { root: require('path').join(__dirname, '../../public') });
});

module.exports = router;
