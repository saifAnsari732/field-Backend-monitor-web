const cron = require('node-cron');
const { Notification } = require('../models');
const { autoStopInactiveSessions, reconcileAllActiveSessions } = require('../controllers/tracking.controller');
const { reconcileAllOrganizations } = require('./subscription.service');

/**
 * Initializes all background cron jobs.
 * @param {Object} io - Socket.io instance for emitting real-time events
 */
function getBusinessDate(date = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

const initCronJobs = (io) => {
  // ── Immediate Startup Check: Reconcile Expired Subscriptions ─────────────
  try {
    reconcileAllOrganizations(io);
  } catch (startupSubErr) {
    console.error('Failed to run initial subscription reconciliation:', startupSubErr.message);
  }

  // ── 1-Day Boundary Rollover & Midnight Reset (Daily at 00:00:00 Asia/Kolkata) ──
  cron.schedule('0 0 * * *', async () => {
    try {
      const yesterday = getBusinessDate(new Date(Date.now() - 24 * 60 * 60 * 1000), 'Asia/Kolkata');
      const today = getBusinessDate(new Date(), 'Asia/Kolkata');
      console.log(`🌙 [MIDNIGHT_CRON] Executing 1-Day KM Boundary Rollover from ${yesterday} to ${today}...`);

      const { LiveLocation, User } = require('../models');

      // 1. Gracefully close leftover sessions from yesterday
      const staleActiveSessions = await LiveLocation.find({
        isActive: true,
        date: { $ne: today }
      });

      for (const s of staleActiveSessions) {
        await LiveLocation.findByIdAndUpdate(s._id, {
          isActive: false,
          endTime: s.endTime || new Date(),
          autoClosed: false,
          manuallyStopped: false
        }).catch(() => {});
      }

      // 2. Reset User.totalDistanceToday to 0 for the fresh new day
      await User.updateMany(
        {},
        { $set: { totalDistanceToday: 0, distanceTodayDate: today, isTracking: false } }
      ).catch(() => {});

      if (io) {
        io.emit('daily_midnight_reset', { date: today });
      }
      console.log(`✅ [MIDNIGHT_CRON] 1-Day Rollover completed. All KM initialized to 0 for ${today}.`);
    } catch (err) {
      console.error('❌ [MIDNIGHT_CRON] Error during midnight rollover:', err);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // ─── Autonomous Subscription Expiry Guardian (Runs Every 15 Minutes) ───────
  // Scans all organizations and auto-locks access when expiresAt timestamp passes
  cron.schedule('*/15 * * * *', async () => {
    try {
      await reconcileAllOrganizations(io);
    } catch (subCronErr) {
      console.error('❌ [CRON] Error running subscription expiry guardian:', subCronErr.message);
    }
  });

  // ─── Continuous Background Sentinel Reconciliation Worker (Runs Every 1 Min) ──
  cron.schedule('* * * * *', async () => {
    try {
      if (typeof reconcileAllActiveSessions === 'function') {
        await reconcileAllActiveSessions();
      }
    } catch (error) {
      console.error('❌ [CRON] Error running background session reconciliation:', error.message);
    }
  });

  // ── Hourly Notification Cleanup ──
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('⏳ [CRON] Running hourly pending notification check...');
      
      await Notification.updateMany(
        { 
          $or: [
            { title: /Tracking stopped automatically/i },
            { message: /without accepted GPS movement/i }
          ],
          isRead: false 
        },
        { $set: { isRead: true } }
      ).catch(() => {});

      const unreadStats = await Notification.aggregate([
        { $match: { isRead: false } },
        { $group: { _id: '$recipient', count: { $sum: 1 } } }
      ]);

      if (unreadStats.length === 0) {
        return;
      }
      console.log(`[CRON] Pending notifications check completed for ${unreadStats.length} users.`);
    } catch (error) {
      console.error('❌ [CRON] Error running pending notification check:', error.message);
    }
  });
};

module.exports = {
  initCronJobs
};
