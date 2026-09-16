# ☁️ Cloud backup (Supabase) — एक बार का setup

App के ⚙ सेटिंग में **Cloud backup (Supabase)** जोड़ने के लिए एक बार Supabase पर
खाता और project बनाना है। कुल 10–15 मिनट, computer पर आसान रहेगा (फ़ोन के
browser से भी हो जाएगा)।

> जुड़ने के बाद कुछ नहीं करना पड़ता — हर entry, खरीद, दर, लिस्ट अपने-आप cloud
> में भी रहती है, और नया फ़ोन लेने पर साइन-इन करते ही सब वापस आ जाता है।

## सबसे कम मेहनत वाला रास्ता — Claude को MCP से जोड़ दो

Claude (Code) को Supabase से **स्थायी रूप से** जोड़ने के दो तरीक़े हैं। जुड़ने के
बाद नीचे भाग 1 के क़दम 3–6 (SQL, signups बंद, user बनाना, URL/key निकालना)
Claude ख़ुद कर देता है — आपको सिर्फ़ खाता और project बनाना होता है।

**तरीक़ा A (सबसे आसान, यही करो): claude.ai का custom connector**
1. https://claude.ai → Settings → **Connectors** → **Add custom connector**
2. URL भरो: `https://mcp.supabase.com/mcp` → Add → Supabase में sign-in करके
   **Authorize** कर दो (OAuth — कोई token/चाबी कहीं नहीं लिखनी पड़ती)
3. बस — अब हर session में Claude के पास Supabase के औज़ार रहेंगे।

**तरीक़ा B (fallback): repo का `.mcp.json` + access token**
repo में `.mcp.json` पहले से रखा है (उसमें कोई राज़ नहीं — token env से आता है):
1. supabase.com → अपने avatar → Account Settings → **Access Tokens** →
   Generate new token (`sbp_…`)
2. claude.ai/code के अपने **environment की settings → Environment variables**
   में `SUPABASE_ACCESS_TOKEN` नाम से डाल दो (git में कभी नहीं!)
3. उसी environment की **network policy** में `api.supabase.com` और
   `*.supabase.co` allow करो — अभी की policy इन्हें रोकती है।

> ध्यान: MCP **Claude को** Supabase से जोड़ता है — फ़ोन की app को नहीं।
> फ़ोन का data cloud तक app का अपना ☁️ Cloud backup (नीचे भाग 2) ही ले जाता
> है; MCP से Claude उसी database को देखता-सँभालता है।

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
> इस project पर क़दम 3, 5 और ताले Claude पहले ही (MCP से) कर चुका है, और
> ताले app-खाते की uid से बँधे हैं — इसलिए क़दम 4 अब सिर्फ़ अच्छी आदत है,
> मजबूरी नहीं। नया project बनाना पड़े तभी ये क़दम हाथ से करने होते हैं।

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

## भाग 2 — App में (एक बार): बस एक चाबी

v1.26.0 से app database को **सीधे छूती ही नहीं** — सारा आना-जाना एक ही secure
API endpoint से होता है (Edge Function `jcm-sync`), और वह हर call पर चाबी
(access token) जाँचता है। server पर चाबी का सिर्फ़ **hash** रखा है।

⚙ सेटिंग → **☁️ Cloud backup** → एक ही खाना: **चाबी (access token)** →
`jcm-…` वाली चाबी डालकर **☁️ जोड़ो और मिलाओ**। बस।

- चाबी setup के समय Claude ने बनाकर दी थी। खो जाए/बदलनी हो तो Claude से
  "नई चाबी बना दो" बोल दो — वह MCP से hash बदलकर नई दे देगा।
- कोई email/password/login नहीं है — Supabase Auth इस्तेमाल ही नहीं होता,
  इसलिए signups वग़ैरह की कोई चिंता नहीं। tables पर सीधी पहुँच (REST) सबके
  लिए बंद है — anon key से भी कुछ नहीं खुलता।
- चाबी app/repo/GitHub में कभी नहीं भरी जाती — सिर्फ़ फ़ोन पर एक बार।
- endpoint: `POST {url}/functions/v1/jcm-sync` (Authorization: Bearer चाबी),
  ops: `ping` / `pull` / `push{rows}` / `del{k}`।

## SQL (क़दम 3 में paste करने के लिए)

```sql
-- झाजी चूड़ा मिल app का cloud खाता — दुबारा चलाने पर भी नहीं बिगड़ता

-- 1) मुख्य table: फ़ोन की हर jcm.* key की एक row
create table if not exists public.jcm_kv (
  k text primary key,
  v jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) History: jcm_kv में जो भी बदले/मिटे, पुरानी क़ीमत अपने-आप यहाँ बचती है —
--    कभी कुछ ग़लत लिखा गया तो हर key के पिछले 20 रूप dashboard से वापस मिल जाते हैं
create table if not exists public.jcm_kv_history (
  id bigint generated always as identity primary key,
  k text not null,
  v jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists jcm_kv_history_k on public.jcm_kv_history (k, id desc);

create or replace function public.jcm_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    insert into public.jcm_kv_history(k, v) values (old.k, old.v);
    delete from public.jcm_kv_history h
     where h.k = old.k
       and h.id not in (select id from public.jcm_kv_history
                         where k = old.k order by id desc limit 20);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists jcm_kv_touch on public.jcm_kv;
create trigger jcm_kv_touch before insert or update or delete on public.jcm_kv
  for each row execute function public.jcm_touch();

-- 3) ताले: सिर्फ़ signed-in user; अकेली anon key से कुछ नहीं खुलता
alter table public.jcm_kv enable row level security;
alter table public.jcm_kv_history enable row level security;

drop policy if exists "signed in users only" on public.jcm_kv;
create policy "signed in users only" on public.jcm_kv
  for all to authenticated using (true) with check (true);

drop policy if exists "history read only" on public.jcm_kv_history;
create policy "history read only" on public.jcm_kv_history
  for select to authenticated using (true);
revoke insert, update, delete on table public.jcm_kv_history from anon, authenticated;

-- trigger-function बाहर से (RPC) कोई न बुला सके — सिर्फ़ trigger ही चलाए
revoke execute on function public.jcm_touch() from public, anon, authenticated;
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
