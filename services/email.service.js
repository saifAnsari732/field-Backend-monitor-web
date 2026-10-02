const nodemailer = require('nodemailer');

// Create reusable transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_EMAIL || 'kisandeveloper2@gmail.com',
      pass: process.env.SMTP_PASSWORD || process.env.EMAIL_PASS,
    },
  });
};

/**
 * Send OTP email for password reset
 */
exports.sendOtpEmail = async (toEmail, otpCode, userName) => {
  const transporter = createTransporter();

  const mailOptions = {
    from: `"KisanConnect Security" <${process.env.SMTP_EMAIL || 'kisandeveloper2@gmail.com'}>`,
    to: toEmail,
    subject: `🔐 Password Reset OTP - ${otpCode}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="max-width:480px;margin:40px auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="background:#059669;padding:32px 24px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;">🔐 Password Reset</h1>
            <p style="color:#d1fae5;margin:8px 0 0;font-size:13px;">KisanConnect Security System</p>
          </div>
          <div style="padding:32px 24px;">
            <p style="color:#334155;font-size:14px;margin:0 0 16px;">Hello <strong>${userName || 'User'}</strong>,</p>
            <p style="color:#64748b;font-size:13px;margin:0 0 24px;line-height:1.6;">We received a request to reset your password. Use the OTP code below to verify your identity:</p>
            <div style="background:#f0fdf4;border:2px solid #059669;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;">
              <p style="margin:0 0 8px;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Your Verification Code</p>
              <p style="margin:0;font-size:36px;font-weight:900;color:#059669;letter-spacing:8px;font-family:monospace;">${otpCode}</p>
            </div>
            <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin:0 0 24px;">
              <p style="margin:0;color:#92400e;font-size:12px;font-weight:600;">⏱ This code expires in 10 minutes</p>
              <p style="margin:4px 0 0;color:#a16207;font-size:11px;">If you didn't request this, please ignore this email.</p>
            </div>
            <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0;">© ${new Date().getFullYear()} KisanConnect SaaS Platform</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  return transporter.sendMail(mailOptions);
};
