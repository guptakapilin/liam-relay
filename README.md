
# Liam Phase 3 (GPT + Sheets + Email)

POST /ask-liam
{
  "prompt": "Write a follow-up message",
  "sendTo": "medhavi"
}

Result:
- GPT generates reply
- Liam pulls medhavi's email from Google Sheet
- Sends the message via Gmail

.env Required:
OPENAI_API_KEY=
GMAIL_USER=
GMAIL_APP_PASS=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_SHEET_ID=
