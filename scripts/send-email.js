/* Send the audit report via SMTP (nodemailer). */
const fs = require('fs');
const nodemailer = require('nodemailer');

const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO'];
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
}

const report = fs.readFileSync('report.txt', 'utf8');
const json = fs.existsSync('report.json') ? fs.readFileSync('report.json', 'utf8') : '';
let parsed = null;
try { parsed = JSON.parse(json); } catch {}
const target = parsed?.target;
const subj = target
  ? `SEO Audit — ${target.host} — Score ${target.composite} (${target.grade})`
  : 'SEO Audit Report';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const recipients = process.env.EMAIL_TO.split(/[,;]\s*/).filter(Boolean);

(async () => {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: recipients,
    subject: subj,
    text: report,
    attachments: json ? [{ filename: 'report.json', content: json }] : [],
  });
  console.log(`Sent to ${recipients.length} recipient(s).`);
})().catch((e) => { console.error(e); process.exit(1); });
