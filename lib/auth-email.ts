import nodemailer from "nodemailer";

type AuthEmail = {
  to: string;
  subject: string;
  url: string;
  action: string;
};

export async function sendAuthEmail({
  to,
  subject,
  url,
  action,
}: AuthEmail) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM;

  if (!host || !Number.isInteger(port) || port < 1 || !user || !password || !from) {
    throw new Error(
      "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM must be configured to send authentication email.",
    );
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass: password },
  });

  await transport.sendMail({
    from,
    to,
    subject,
    text: `${action}\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
  });
}
