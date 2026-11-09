# Free demo deployment: Neon (database) + Render (API) + Vercel (frontend)

Everything below is free-tier. The API sleeps after 15 min without traffic; the first request afterwards takes ~30–60 s.

## 1. Neon: database

1. Create a project at neon.tech (pick a region close to your Render region, e.g. Frankfurt).
2. Copy the connection string from **Connect** and choose **Direct connection** (host *without* `-pooler`).
   The chatbot sets session options that Neon's pooled endpoint rejects.
   Keep `?sslmode=require` at the end. This is `NEON_URL` below.
3. Copy your local data into Neon (schema, 175 reports, and the stored embeddings, so no re-embedding is needed). Docker must be running with `sporto_poc_db` up:

```bash
docker exec sporto_poc_db pg_dump -U postgres -d sporto_poc --no-owner --no-privileges -Fc -f /tmp/sporto.dump
docker exec sporto_poc_db pg_restore --no-owner --no-privileges -d "NEON_URL" /tmp/sporto.dump
```

4. Create the read-only chatbot role with its own password (run from the Backend folder; pick a long random password):

```bash
DATABASE_URL="NEON_URL" CHAT_READER_PASSWORD="<random>" npm run db:migrate
```

   `CHAT_DATABASE_URL` = `NEON_URL` with the user and password replaced by `chat_reader` / `<random>`
   (URL-encode special characters in the password).

## 2. Render: API

1. Push the Backend repo to GitHub (Render deploys from Git).
2. Render → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. Fill in the prompted variables:
   - `DATABASE_URL` = `NEON_URL`
   - `CHAT_DATABASE_URL` = the `chat_reader` URL from step 1.4
   - `OPENAI_API_KEY`
   - `CORS_ORIGIN` = your Vercel URL (add it after step 3; edit the variable and redeploy)
4. When it is live, open `https://<name>.onrender.com/health`. It should show `{"status":"ok"}`.

## 3. Vercel: frontend

1. Push the Frontend repo to GitHub, then import it in Vercel (framework: Vite).
2. Environment variable: `VITE_API_URL` = `https://<name>.onrender.com`.
3. Single-page-app deep links (e.g. `/reports/12`) need this `vercel.json` in the Frontend repo root, otherwise a page refresh gives 404:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

## Before sharing the link

- Set a **monthly spend limit** in your OpenAI account. Anyone with the URL can use the chatbot.
- The API has no login. `ACCESS_KEY` (optional env var on Render) makes the API require an `x-access-key` header or `access_key` query parameter, but the frontend must be changed to send it first. Do not set it until then, or the app will stop working.
- Neon free tier: compute sleeps after 5 min idle (first query is slow); 0.5 GB storage is plenty for this data.
