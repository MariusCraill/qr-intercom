const express = require('express');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const router = express.Router();

// The resident app is one page; /resident/<callId> deep-links into a call.
const sendResidentPage = (req, res) => res.sendFile('resident.html', { root: PUBLIC_DIR });
router.get('/', sendResidentPage);
router.get('/:callId', sendResidentPage);

module.exports = router;
