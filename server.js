require('dotenv').config();
const express = require('express');
const path = require('path');

const menuRoutes = require('./routes/menu');
const { router: tabRoutes } = require('./routes/tabs');
const agentRoutes = require('./routes/agent');
const settingsRoutes = require('./routes/settings');
const feesRoutes = require('./routes/fees');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lets the frontend read the PayPal Client ID without hardcoding it in HTML.
app.get('/api/config', (req, res) => {
  res.json({
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    currency: process.env.CURRENCY || 'USD',
  });
});

app.use('/api', feesRoutes);
app.use('/api', settingsRoutes);
app.use('/api', menuRoutes);
app.use('/api', tabRoutes);
app.use('/api', agentRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dropfirst running at http://localhost:${PORT}`);
});
