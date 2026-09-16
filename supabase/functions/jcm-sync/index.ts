// JCM लोडिंग app का sync endpoint — app इसे सिर्फ़ चाबी (access token) से बुलाती है।
// verify_jwt बंद है क्योंकि auth यहीं अपनी है: Bearer चाबी का sha256 hash
// public.jcm_tokens से मिलना ज़रूरी, वरना 401। tables तक सीधी पहुँच सबके लिए
// बंद है (RLS + revoke) — यही endpoint इकलौता रास्ता है।
// (यह फ़ाइल record के लिए repo में है; तैनाती Claude MCP से करता है।)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const json = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") || "");
  if (!m) return json(401, { error: "चाबी नहीं मिली" });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const hash = await sha256hex(m[1]);
  const { data: tok, error: tokErr } = await db
    .from("jcm_tokens").select("id").eq("token_hash", hash).maybeSingle();
  if (tokErr) return json(500, { error: tokErr.message });
  if (!tok) return json(401, { error: "चाबी ग़लत या बदल दी गई है" });

  let body: { op?: string; rows?: unknown; k?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: "JSON body चाहिए" }); }

  if (body.op === "ping") return json(200, { ok: true });

  if (body.op === "pull") {
    const { data, error } = await db.from("jcm_kv").select("k,v,updated_at");
    if (error) return json(500, { error: error.message });
    return json(200, { rows: data });
  }

  if (body.op === "push") {
    const rows = Array.isArray(body.rows) ? body.rows as Array<{ k: unknown; v: unknown }> : [];
    if (!rows.length) return json(400, { error: "rows ख़ाली" });
    for (const r of rows) {
      if (!r || typeof r.k !== "string" || !r.k.startsWith("jcm.")) {
        return json(400, { error: "हर row में jcm.* वाली k चाहिए" });
      }
    }
    const { data, error } = await db.from("jcm_kv")
      .upsert(rows.map((r) => ({ k: r.k as string, v: r.v })), { onConflict: "k" })
      .select("k,updated_at");
    if (error) return json(500, { error: error.message });
    return json(200, { rows: data });
  }

  if (body.op === "del") {
    if (typeof body.k !== "string") return json(400, { error: "k चाहिए" });
    const { error } = await db.from("jcm_kv").delete().eq("k", body.k);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(400, { error: "op समझ नहीं आया (ping/pull/push/del)" });
});
