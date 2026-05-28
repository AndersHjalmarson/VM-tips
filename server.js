const express = require('express');
const path = require('path');
const { initializeDatabase } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', require('./src/routes/api'));
app.use('/admin/api', require('./src/routes/admin'));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

initializeDatabase();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VM-tipset 2026 körs på http://0.0.0.0:${PORT}`);
  console.log(`Admin-panel: http://localhost:${PORT}/admin`);
});
