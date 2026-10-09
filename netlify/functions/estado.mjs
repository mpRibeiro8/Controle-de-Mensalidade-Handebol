import { getStore } from "@netlify/blobs";

// Regras de alteração dos dados. O servidor aplica estas operações no estado
// guardado, e a página aplica as mesmas para responder na hora ao toque.
// (O conteúdo deste arquivo também é copiado para dentro de public/index.html.)

const MES = /^\d{4}-\d{2}$/;
const texto = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

export function defaultState() {
  const atletas = [];
  for (let i = 1; i <= 3; i++) atletas.push({ id: "a" + i, nome: "" });
  return { rev: 0, valor: 30, grupos: [{ id: "masculino", nome: "Masculino", atletas }], pag: {} };
}

export function normalize(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.grupos) || !d.grupos.length) return defaultState();
  if (!d.pag || typeof d.pag !== "object") d.pag = {};
  if (typeof d.valor !== "number" || !isFinite(d.valor)) d.valor = 30;
  if (typeof d.rev !== "number") d.rev = 0;
  return d;
}

export function mesDelta(m, d) {
  const p = m.split("-");
  const dt = new Date(+p[0], +p[1] - 1 + d, 1);
  return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
}

function limparAtleta(a) {
  if (!a || typeof a.id !== "string" || !a.id || a.id.length > 24) return null;
  const r = { id: a.id, nome: texto(a.nome, 60) };
  if (typeof a.de === "string" && MES.test(a.de)) r.de = a.de;
  return r;
}

export function applyOp(S, op) {
  if (!op || typeof op !== "object") return S;
  const g = typeof op.gid === "string" ? S.grupos.find((x) => x.id === op.gid) : null;
  switch (op.t) {
    case "status": {
      if (!g || !MES.test(op.mes) || !g.atletas.some((a) => a.id === op.aid)) break;
      if (!S.pag[g.id]) S.pag[g.id] = {};
      if (!S.pag[g.id][op.mes]) S.pag[g.id][op.mes] = {};
      if (op.st === "S" || op.st === "N") S.pag[g.id][op.mes][op.aid] = op.st;
      else delete S.pag[g.id][op.mes][op.aid];
      break;
    }
    case "nome": {
      const a = g && g.atletas.find((x) => x.id === op.aid);
      if (a) a.nome = texto(op.nome, 60);
      break;
    }
    case "addAtleta": {
      const a = limparAtleta(op.atleta);
      if (!g || !a || g.atletas.length >= 200 || g.atletas.some((x) => x.id === a.id)) break;
      g.atletas.push(a);
      break;
    }
    case "remAtleta": {
      if (!g || !MES.test(op.mes)) break;
      const a = g.atletas.find((x) => x.id === op.aid);
      if (!a) break;
      const porMes = S.pag[g.id] || {};
      // apaga as marcações do mês indicado em diante; os meses anteriores ficam como estavam
      Object.keys(porMes).forEach((k) => { if (k >= op.mes) delete porMes[k][a.id]; });
      if (a.de && a.de >= op.mes) g.atletas = g.atletas.filter((x) => x.id !== a.id);
      else a.ate = mesDelta(op.mes, -1);
      break;
    }
    case "valor": {
      if (typeof op.valor === "number" && isFinite(op.valor) && op.valor >= 0 && op.valor <= 100000) S.valor = op.valor;
      break;
    }
    case "addGrupo": {
      const n = op.grupo;
      if (!n || typeof n.id !== "string" || !n.id || n.id.length > 24 || S.grupos.length >= 20) break;
      if (S.grupos.some((x) => x.id === n.id)) break;
      const nome = texto(n.nome, 24).trim();
      if (!nome) break;
      const atletas = (Array.isArray(n.atletas) ? n.atletas : []).slice(0, 200).map(limparAtleta).filter(Boolean);
      S.grupos.push({ id: n.id, nome, atletas });
      break;
    }
    case "renGrupo": {
      const nome = texto(op.nome, 24).trim();
      if (g && nome) g.nome = nome;
      break;
    }
    case "delGrupo": {
      if (!g || S.grupos.length <= 1) break;
      S.grupos = S.grupos.filter((x) => x.id !== g.id);
      delete S.pag[g.id];
      break;
    }
  }
  return S;
}


const TENTATIVAS = 8;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function codigoEsperado() {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get) return Netlify.env.get("CODIGO_ACESSO") || "";
  } catch (e) { /* segue para process.env */ }
  return (typeof process !== "undefined" && process.env && process.env.CODIGO_ACESSO) || "";
}

// Leitura sempre atualizada (consistência forte). Sem isso o Netlify pode devolver
// uma cópia antiga logo depois de uma gravação, e os nomes voltam para valores velhos.
async function ler(armazem) {
  const r = await armazem.getWithMetadata("estado", { type: "json", consistency: "strong" });
  if (!r) return { S: normalize(null), etag: null, existe: false };
  return { S: normalize(r.data), etag: r.etag || null, existe: true };
}

// Gravação condicional: só vale se ninguém gravou no meio do caminho.
async function gravar(armazem, S, etag, existe) {
  const opcoes = etag ? { onlyIfMatch: etag } : existe ? {} : { onlyIfNew: true };
  const r = await armazem.setJSON("estado", S, opcoes);
  return !r || r.modified !== false;
}

// "armazem" é injetável para testes. Em produção usa o Netlify Blobs.
export async function tratar(req, armazem, codigo) {
  if (codigo && req.headers.get("x-codigo") !== codigo) return json({ erro: "codigo" }, 401);

  if (req.method === "GET") {
    const { S } = await ler(armazem);
    return json({ estado: S });
  }

  if (req.method === "POST") {
    let corpo;
    try { corpo = await req.json(); } catch (e) { return json({ erro: "json" }, 400); }
    const ops = Array.isArray(corpo && corpo.ops) ? corpo.ops : null;
    if (!ops || ops.length > 100) return json({ erro: "ops" }, 400);

    for (let i = 0; i < TENTATIVAS; i++) {
      const { S, etag, existe } = await ler(armazem);
      ops.forEach((op) => applyOp(S, op));
      S.rev = (S.rev || 0) + 1;
      if (await gravar(armazem, S, etag, existe)) return json({ estado: S });
      await new Promise((ok) => setTimeout(ok, 30 + Math.random() * 120));   // outra pessoa gravou agora; tenta de novo
    }
    return json({ erro: "ocupado" }, 503);
  }

  return json({ erro: "metodo" }, 405);
}

export default async (req) => tratar(req, getStore({ name: "mensalidades", consistency: "strong" }), codigoEsperado());

export const config = { path: "/api/estado" };
