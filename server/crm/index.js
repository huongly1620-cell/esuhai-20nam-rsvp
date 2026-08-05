'use strict';

const path = require('path');
const auth = require('./auth');
const audit = require('./audit');
const guests = require('./guests');
const stats = require('./stats');
const photos = require('./photos');
const importer = require('./import');

// Which app shell to serve for the authed /crm entry.
// CRM_UI=new  -> mockup-based UI (crm-app-v2.html). Default 'classic' keeps the
// current shell live so cutover is a single env flip, and rollback is instant
// (E08-D017 / AC-17). /crm/classic ALWAYS serves the old shell for fallback.
function appShell() {
  return (process.env.CRM_UI || 'classic').toLowerCase() === 'new'
    ? 'crm-app-v2.html'
    : 'crm-app.html';
}

// Mounts all CRM + auth routes. Kept fully separate from /admin and /api/rsvp.
function mount(app) {
  // Mobile UI entry: login screen if no valid CRM cookie, else the app shell.
  app.get('/crm', (req, res) => {
    const authed = !!auth.currentActor(req);
    res.sendFile(path.join(__dirname, 'views', authed ? appShell() : 'crm-login.html'));
  });

  // Rollback lane: the classic shell, regardless of CRM_UI. Same auth gate.
  app.get('/crm/classic', (req, res) => {
    const authed = !!auth.currentActor(req);
    res.sendFile(path.join(__dirname, 'views', authed ? 'crm-app.html' : 'crm-login.html'));
  });

  auth.mount(app);                                  // /auth/* + /crm/me
  // allowDoor CHỈ được truyền cho guests + photos, và bên trong chỉ dùng cho
  // đúng các route trang cửa gọi. stats / import / audit vẫn requireCrmAuth.
  guests.mount(app, auth.requireCrmAuth, auth.requireRole, auth.allowDoor);
  stats.mount(app, auth.requireCrmAuth);
  photos.mount(app, auth.requireCrmAuth, auth.allowDoor);
  importer.mount(app, auth.requireCrmAuth, auth.requireRole);
  audit.mount(app, auth.requireCrmAuth, auth.requireRole);
}

module.exports = { mount };
