# V31 Notification Setup Checklist

Start with the easiest route and add the paid channels only if you want them.

## Fastest setup
1. Deploy V31.
2. Open **Alerts**.
3. Click **Enable browser alerts** on every dashboard PC/phone.
4. Configure Telegram in Render for remote phone alerts.
5. Press **Send Telegram test**.

## True background Web Push
Run `npm install` then `npm run vapid` once on a trusted computer. Put the generated public/private values in Render as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Do not commit the private key to GitHub. Redeploy, then click **Enable browser alerts** again on each receiving browser.

## Optional Twilio
WhatsApp: configure Account SID/Auth Token + WhatsApp sender/to. Production proactive WhatsApp alerts can require an approved template; V31 supports `TWILIO_WHATSAPP_CONTENT_SID`.

SMS: configure Account SID/Auth Token + SMS from/to. Charges and sender-registration rules can apply.

## Security
Use `NOTIFY_ACCESS_PIN`, or leave it blank and V31 will reuse `AI_ACCESS_PIN`. Never put API tokens or private keys in frontend code or GitHub.
