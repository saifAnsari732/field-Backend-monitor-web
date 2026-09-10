const fs = require('fs');
let c = fs.readFileSync('server.js', 'utf8');

if (!c.includes('/api/manager')) {
  c = c.replace(
    "app.use('/api/admin', require('./routes/admin.routes'));",
    "app.use('/api/admin', require('./routes/admin.routes'));\napp.use('/api/manager', require('./routes/manager.routes'));"
  );
  fs.writeFileSync('server.js', c);
}
