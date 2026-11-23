// Busca os dados do painel FastZap, guarda o histórico e gera artifact/data.json.
// Uso: node scripts/gerar-dados.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API = 'https://wpbeta-2029.sysprime.com.br/employee_score/';
const raiz = new URL('../', import.meta.url);
const arq = (p) => new URL(p, raiz);
const TZ = 'America/Sao_Paulo';
const MAX_HIST = 24 * 4 * 120; // até ~120 dias de coletas a cada 15 min

const lerJson = async (p, padrao) => { try { return JSON.parse(await readFile(arq(p), 'utf8')); } catch { return padrao; } };

function mesAtual() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
}
function mesesAtras(mes, k) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
async function buscar(mes) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const r = await fetch(`${API}?month=${mes}&user_id=387&permission=master_franchisee`);
      if (!r.ok) throw new Error(`API respondeu ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [j];
    } catch (e) {
      if (tentativa >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}
function regioes(arvore) {
  const out = {};
  for (const gestor of arvore[0]?.children || []) {
    const regional = (gestor.children || []).find((c) => c.rule_type === 'regional_manager');
    if (regional) out[gestor.values.uf] = regional;
  }
  return out;
}
const V = (v) => ({
  tot: +v.total_atendimentos, uni: +v.total_atendimentos_telefones_unicos, ati: +v.atendimentos_ativos,
  pend: +v.atendimentos_nao_atendidos, neg: +v.atendimentos_em_negociacao,
  tme: Math.round(+v.tme), tma: Math.round(+v.tna),
});
// Árvore enxuta: região -> franqueados -> lojas (pula o "master franqueado" duplicado)
function enxugar(no) {
  let filhos = no.children || [];
  if (filhos.length === 1 && filhos[0].rule_type === 'master_franchisee' && filhos[0].name === no.name) filhos = filhos[0].children || [];
  const out = { n: no.name, t: no.rule_type, v: V(no.values) };
  if (filhos.length) out.c = filhos.map(enxugar).sort((a, b) => b.v.tot - a.v.tot);
  return out;
}

const mes = mesAtual();
const arvore = await buscar(mes);
const reg = regioes(arvore);
if (!reg.DF && !reg.MG) throw new Error('Não encontrei as regiões DF/MG na resposta');

// histórico (um retrato por execução)
const historico = await lerJson('data/history.json', []);
const snap = { t: new Date().toISOString(), m: mes, r: {} };
for (const uf of Object.keys(reg)) snap.r[uf] = V(reg[uf].values);
historico.push(snap);
const histFinal = historico.slice(-MAX_HIST);
await mkdir(arq('data/'), { recursive: true });
await writeFile(arq('data/history.json'), JSON.stringify(histFinal));

// meses fechados ficam em cache
const cacheMeses = await lerJson('data/meses.json', {});
const meses = [];
for (let k = 11; k >= 0; k--) {
  const m = mesesAtras(mes, k);
  if (m === mes) { meses.push({ mes: m, DF: reg.DF ? +reg.DF.values.total_atendimentos : null, MG: reg.MG ? +reg.MG.values.total_atendimentos : null }); continue; }
  if (!cacheMeses[m]) {
    try {
      const r = regioes(await buscar(m));
      cacheMeses[m] = { mes: m, DF: r.DF ? +r.DF.values.total_atendimentos : null, MG: r.MG ? +r.MG.values.total_atendimentos : null };
    } catch { cacheMeses[m] = null; }
  }
  meses.push(cacheMeses[m] || { mes: m, DF: null, MG: null });
}
await writeFile(arq('data/meses.json'), JSON.stringify(cacheMeses));

const dados = {
  geradoEm: snap.t,
  mes,
  regioes: Object.fromEntries(Object.entries(reg).map(([uf, no]) => [uf, enxugar(no)])),
  meses,
  historico: histFinal.map((s) => ({ t: s.t, m: s.m, r: Object.fromEntries(Object.entries(s.r).filter(([uf]) => uf === 'DF' || uf === 'MG').map(([uf, v]) => [uf, { tot: v.tot, pend: v.pend, tme: v.tme }])) })),
};
await writeFile(arq('data.json'), JSON.stringify(dados));
console.log(`OK ${snap.t} — DF ${dados.regioes.DF?.v.tot} / MG ${dados.regioes.MG?.v.tot} — histórico: ${histFinal.length} coletas`);
