const fs = require('fs');
let c = fs.readFileSync('server.js', 'utf8');

c = c.replace(
  "mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/')\n  .then(() => console.log('✅ MongoDB connected'))\n  .catch(err => console.error('❌ MongoDB error:', err));",
  \mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/')
  .then(async () => {
    console.log('✅ MongoDB connected');
    try {
      const User = require('./models/User');
      await User.updateMany({ isOnline: true }, { isOnline: false, socketId: null });
      console.log('🔄 Reset all online users to offline on server startup.');
    } catch(err) {
      console.error('Failed to reset online status:', err);
    }
  })
  .catch(err => console.error('❌ MongoDB error:', err));\
);

fs.writeFileSync('server.js', c);
