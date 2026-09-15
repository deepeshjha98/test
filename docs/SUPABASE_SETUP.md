# ☁️ Cloud backup (Supabase) — एक बार का setup

App के ⚙ सेटिंग में **Cloud backup (Supabase)** जोड़ने के लिए एक बार Supabase पर
खाता और project बनाना है। कुल 10–15 मिनट, computer पर आसान रहेगा (फ़ोन के
browser से भी हो जाएगा)।

> जुड़ने के बाद कुछ नहीं करना पड़ता — हर entry, खरीद, दर, लिस्ट अपने-आप cloud
> में भी रहती है, और नया फ़ोन लेने पर साइन-इन करते ही सब वापस आ जाता है।

## भाग 1 — Supabase project (एक बार)

1. **https://supabase.com** खोलो → *Start your project* → खाता बनाओ
   (Google/GitHub से sign in सबसे आसान)।
2. **New project** →
   - Name: `JCM`
   - Database password: कोई भी मज़बूत password (यह database का है, app में
     नहीं लगेगा — फिर भी लिखकर रखो)
   - Region: **Mumbai (ap-south-1)**
   - → **Create new project** (1–2 मिनट लगते हैं)
3. बाएँ में **SQL Editor** → नीचे वाला पूरा SQL paste करो → **Run**।
   हरा "Success. No rows returned" आना चाहिए। (दुबारा चला दो तो भी कुछ
   बिगड़ता नहीं।)
4. बाएँ **Authentication → Sign In / Providers** (Email वाला हिस्सा) →
   **"Allow new users to sign up" को बंद (OFF)** करो → Save।
   *(यह ज़रूरी है — वरना anon key हाथ लगने पर कोई भी खाता बनाकर data देख
   सकता है।)*
5. **Authentication → Users → Add user → Create new user**:
   - Email: अपना email
   - Password: एक password चुनो — **यही app में डालोगे**
   - **Auto Confirm User ✓ ज़रूर लगाओ** (नहीं लगाया तो app कहेगा
     "email confirmed नहीं")
   - → Create user
6. **Project Settings (⚙) → API** से दो चीज़ें copy करो:
   - **Project URL** (जैसे `https://abcdxyz.supabase.co`)
   - **anon public** key (लंबी `eyJ…` या `sb_publishable_…`)

## भाग 2 — App में (एक बार)

⚙ सेटिंग → **☁️ Cloud backup (Supabase)** → चारों चीज़ें भरो:

| खाना | कहाँ से |
|---|---|
| Project URL | भाग 1, क़दम 6 |
| anon public key | भाग 1, क़दम 6 |
| Email | भाग 1, क़दम 5 |
| Password | भाग 1, क़दम 5 |

→ **☁️ जोड़ो और मिलाओ**। ऊपर ✅ आ जाए तो हो गया।

## SQL (क़दम 3 में paste करने के लिए)

```sql
-- झाजी चूड़ा मिल app का cloud खाता — दुबारा चलाने पर भी नहीं बिगड़ता
create table if not exists public.jcm_kv (
  k text primary key,
  v jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.jcm_kv enable row level security;

drop policy if exists "signed in users only" on public.jcm_kv;
create policy "signed in users only" on public.jcm_kv
  for all to authenticated using (true) with check (true);

create or replace function public.jcm_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists jcm_kv_touch on public.jcm_kv;
create trigger jcm_kv_touch before insert or update on public.jcm_kv
  for each row execute function public.jcm_touch();
```

## ये 4 चीज़ें लिखकर सँभाल लो

नया फ़ोन जोड़ने के लिए यही चारों फिर चाहिए होंगी — **पुराने फ़ोन के अलावा भी
कहीं** (डायरी/परिवार के फ़ोन पर) लिख लो:

1. Project URL
2. anon public key (यह dashboard के Settings → API में हमेशा मिल जाती है)
3. Email
4. Password (app इसे save नहीं करती)

Password भूल जाओ → dashboard → Authentication → Users → अपने user के ⋮ menu
से नया password भेजो/बदलो।

## जानने लायक़ दो बातें

- **Free project सो जाता है**: क़रीब एक हफ़्ता कोई इस्तेमाल न हो (मौसम-बंदी
  में आम बात) तो Supabase free project को रोक देता है। App तब ⚙ में साफ़
  बताएगी। **supabase.com का dashboard खोलकर project खोलते ही वह जग जाता है**
  (Restore/Resume बटन) — data वहीं रहता है।
  - चाहो तो GitHub अपने-आप जगाए रखे: repo के **Settings → Secrets and
    variables → Actions** में दो secret भरो — `SUPABASE_URL` और
    `SUPABASE_ANON_KEY` — बस। हफ़्ते में दो बार अपने-आप ping जाएगा
    (workflow पहले से रखा है; secrets ख़ाली हों तो कुछ नहीं करता)।
- **राज़ git में नहीं**: URL/key/email/password — कुछ भी code या GitHub में
  नहीं लिखा जाता (repo public है)। ये सिर्फ़ app के अंदर फ़ोन में रहते हैं,
  और GitHub secrets में (अगर ऊपर वाला ping चालू करो तो)।
