'use strict';

const path = require('path');
const auth = require('./auth');
const audit = require('./audit');
const guests = require('./guests');
const photos = require('./photos');
const importer = require('./import');

// Mounts all CRM + auth routes. Kept fully separate from /admin and /api/rsvp.
function mount(app) {
  // Mobile UI entry: login screen if no valid CRM cookie, else the app shell.
  app.get('/crm', (req, res) => {
    const authed = !!auth.currentActor(req);
    res.sendFile(path.join(__dirname, 'views', authed ? 'crm-app.html' : 'crm-login.html'));
  });

  auth.mount(app);                                  // /auth/* + /crm/me
  guests.mount(app, auth.requireCrmAuth, auth.requireRole);
  photos.mount(app, auth.requireCrmAuth);
  importer.mount(app, auth.requireCrmAuth, auth.requireRole);
  audit.mount(app, auth.requireCrmAuth, auth.requireRole);
}

module.exports = { mount };
