/**
 * bmr-sync - shared store for District Budget Modification Request (BMR) data.
 *
 * Endpoints:
 *   PUT /bmr/{district}  - a district dashboard publishes its current BMR data
 *   GET /bmr             - the BMR Updates tab reads every district at once
 *   GET /bmr/{district}  - read a single district
 *
 * Storage: KV namespace bound as BMR (key per district, last write wins).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'bmr') return new Response('Not found', { status: 404, headers: cors });
    const json = { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' };

    if (request.method === 'PUT' && parts[1]) {
      const district = parts[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!district) return new Response('Bad district', { status: 400, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
      if (JSON.stringify(body).length > 200000) return new Response('Too large', { status: 413, headers: cors });
      const record = { ...body, district, updatedAt: new Date().toISOString() };
      await env.BMR.put('bmr:' + district, JSON.stringify(record));
      return new Response(JSON.stringify({ ok: true, district }), { headers: json });
    }

    if (request.method === 'GET' && !parts[1]) {
      const list = await env.BMR.list({ prefix: 'bmr:' });
      const out = [];
      for (const k of list.keys) {
        const v = await env.BMR.get(k.name);
        if (v) { try { out.push(JSON.parse(v)); } catch {} }
      }
      return new Response(JSON.stringify({ districts: out }), { headers: json });
    }

    if (request.method === 'GET' && parts[1]) {
      const v = await env.BMR.get('bmr:' + parts[1].toLowerCase());
      return new Response(v || 'null', { headers: json });
    }

    return new Response('Method not allowed', { status: 405, headers: cors });
  }
};
