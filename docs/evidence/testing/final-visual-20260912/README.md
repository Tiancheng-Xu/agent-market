# Final visual v4 evidence

Status: **verified-local**

- Matrix: 18 routes x 5 widths x 2 locales = 180 combinations.
- Widths: 375, 390, 430, 1440, and 1920 pixels.
- Locales: `zh-CN` and `en`.
- Automated findings: zero horizontal overflow, broken images, empty buttons, page errors, untranslated Chinese, untranslated English, or mixed-language findings.
- Cocos Office ready time: 630-674 ms across the five widths.
- Human review: 12 key Chinese screenshots at 390 and 1920 widths.

The machine result is `result.json`. The PNG files in this directory are the 12 manually reviewed key-route captures. This evidence proves the local rendered candidate only. It does not prove a Git commit, Cloudflare deployment, production Runtime availability, AWS activity, Sepolia transaction, or Chainlink callback.
