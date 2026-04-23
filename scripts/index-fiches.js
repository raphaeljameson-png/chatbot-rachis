/**
 * index-fiches.js — Indexation des fiches patient EFR vers Firestore
 *
 * Source : repo GitHub fiches-information-patient (branch main)
 * Pipeline :
 *   1. Fetch de la liste des fiches HTML depuis GitHub (raw)
 *   2. Extraction du JSON-LD FAQPage (gold standard, Q/R validées)
 *   3. Extraction du texte principal (fallback si FAQ vide)
 *   4. Chunking en ~300 mots avec overlap
 *   5. Embedding via Voyage AI (voyage-multilingual-2, 1024 dims)
 *   6. Écriture dans Firestore collection `fiches_chunks`
 *
 * Usage :
 *   VOYAGE_API_KEY=pa-xxx \
 *   GOOGLE_APPLICATION_CREDENTIALS=/chemin/vers/service-account.json \
 *   node scripts/index-fiches.js
 *
 * Peut être relancé : il fait un upsert (efface puis réécrit tout).
 */

const admin = require("firebase-admin");

// ─── Configuration ────────────────────────────────────────────────────────
const FICHES_REPO = "raphaeljameson-png/fiches-information-patient";
const FICHES_BRANCH = "main";
const FICHES_BASE_URL = `https://raw.githubusercontent.com/${FICHES_REPO}/${FICHES_BRANCH}`;
const PORTAL_BASE_URL = `https://raphaeljameson-png.github.io/fiches-information-patient`;

// Liste exhaustive des fiches à indexer (chemins relatifs)
const FICHES = [
  { path: "cervical/acdf.html",                    titre: "Arthrodèse cervicale ACDF",          region: "cervical" },
  { path: "cervical/prothese-discale.html",        titre: "Prothèse discale cervicale",         region: "cervical" },
  { path: "cervical/laminectomie.html",            titre: "Canal cervical étroit (voie postérieure)", region: "cervical" },
  { path: "cervical/livret-kine.html",             titre: "Livret kiné cervical",               region: "cervical" },
  { path: "lombaire/hernie-discale.html",          titre: "Hernie discale lombaire",            region: "lombaire" },
  { path: "lombaire/alif.html",                    titre: "Arthrodèse ALIF",                    region: "lombaire" },
  { path: "lombaire/tlif.html",                    titre: "Arthrodèse TLIF mini-invasive",      region: "lombaire" },
  { path: "lombaire/arthrodese-posterieure.html",  titre: "Arthrodèse postérieure conventionnelle", region: "lombaire" },
  { path: "lombaire/stenose-mini-invasive.html",   titre: "Sténose lombaire mini-invasive",     region: "lombaire" },
  { path: "lombaire/laminectomie.html",            titre: "Canal lombaire étroit (open)",       region: "lombaire" },
  { path: "lombaire/prothese-discale.html",        titre: "Prothèse discale lombaire",          region: "lombaire" },
  { path: "lombaire/neurolyse.html",               titre: "Neurolyse lombaire",                 region: "lombaire" },
  { path: "lombaire/reeducation-post-op.html",     titre: "Rééducation post-opératoire lombaire", region: "lombaire" },
  { path: "lombaire/reprise-travail.html",         titre: "Reprise du travail après chirurgie lombaire", region: "lombaire" },
  { path: "lombaire/ube-endoscopie.html",          titre: "Endoscopie UBE du rachis",           region: "lombaire" },
  { path: "lombaire/livret-kine.html",             titre: "Livret kiné lombaire",               region: "lombaire" },
  { path: "sacro-iliaque/arthrodese.html",         titre: "Arthrodèse sacro-iliaque",           region: "sacro-iliaque" },
  { path: "procedures/cimentoplastie-spinejack.html", titre: "Cimentoplastie / SpineJack",      region: "procedures" },
  { path: "procedures/infiltrations.html",         titre: "Infiltrations rachidiennes",         region: "procedures" },
  { path: "ressources/livret-transversal.html",    titre: "Livret transversal (préparation)",   region: "ressources" },
  { path: "ressources/conseils-kine.html",         titre: "Conseils pour le kinésithérapeute",  region: "ressources" },
  { path: "ressources/ecole-du-dos.html",          titre: "École du dos — bonnes postures",     region: "ressources" },
];

const CHUNK_WORDS = 300;
const CHUNK_OVERLAP = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function extractFAQ(html) {
  const faqs = [];
  const jsonLdMatches = html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data["@type"] === "FAQPage" && Array.isArray(data.mainEntity)) {
        for (const q of data.mainEntity) {
          if (q["@type"] === "Question" && q.name && q.acceptedAnswer?.text) {
            faqs.push({
              question: q.name.trim(),
              reponse: q.acceptedAnswer.text.trim(),
            });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  return faqs;
}

function extractMeta(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const desc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  return {
    h1: h1 ? stripHtml(h1[1]) : "",
    description: desc ? desc[1] : "",
  };
}

function extractBody(html) {
  let bodyMatch = html.match(/<div[^>]+class=["'][^"']*\bpage\b[^"']*["'][^>]*>([\s\S]+?)<\/div>\s*<\/div>/i);
  if (!bodyMatch) bodyMatch = html.match(/<main[^>]*>([\s\S]+?)<\/main>/i);
  if (!bodyMatch) bodyMatch = html.match(/<body[^>]*>([\s\S]+?)<\/body>/i);
  const raw = bodyMatch ? bodyMatch[1] : html;
  return stripHtml(raw);
}

function chunkText(text, wordsPerChunk = CHUNK_WORDS, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= wordsPerChunk) return [text];
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + wordsPerChunk, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlap;
  }
  return chunks;
}

async function embedBatch(texts, voyageApiKey, inputType = "document") {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${voyageApiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: "voyage-multilingual-2",
      input_type: inputType,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Voyage API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Pipeline principal ───────────────────────────────────────────────────

async function main() {
  const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
  if (!VOYAGE_API_KEY) {
    console.error("ERREUR : VOYAGE_API_KEY manquante dans l'environnement.");
    process.exit(1);
  }

  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  console.log(`\n=== Indexation ${FICHES.length} fiches EFR ===\n`);

  console.log("1. Nettoyage de l'ancienne collection fiches_chunks...");
  const oldSnap = await db.collection("fiches_chunks").get();
  if (!oldSnap.empty) {
    for (let i = 0; i < oldSnap.docs.length; i += 400) {
      const batch = db.batch();
      oldSnap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`   Supprimé ${oldSnap.size} anciens chunks.\n`);
  } else {
    console.log("   (collection vide)\n");
  }

  console.log("2. Téléchargement et extraction des fiches...");
  const allChunks = [];
  for (const fiche of FICHES) {
    const url = `${FICHES_BASE_URL}/${fiche.path}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`   ⚠ ${fiche.path} : HTTP ${resp.status}, sauté.`);
      continue;
    }
    const html = await resp.text();
    const faqs = extractFAQ(html);
    const body = extractBody(html);

    const ficheUrl = `${PORTAL_BASE_URL}/${fiche.path}`;
    const ficheId = fiche.path.replace(/[\/\.]/g, "_").replace(/_html$/, "");

    for (let i = 0; i < faqs.length; i++) {
      const f = faqs[i];
      allChunks.push({
        id: `${ficheId}__faq_${i}`,
        texte: `Question : ${f.question}\nRéponse : ${f.reponse}`,
        type: "faq",
        question: f.question,
        fiche_titre: fiche.titre,
        fiche_url: ficheUrl,
        fiche_region: fiche.region,
        fiche_path: fiche.path,
      });
    }

    const bodyChunks = chunkText(body);
    for (let i = 0; i < bodyChunks.length; i++) {
      allChunks.push({
        id: `${ficheId}__body_${i}`,
        texte: bodyChunks[i],
        type: "body",
        fiche_titre: fiche.titre,
        fiche_url: ficheUrl,
        fiche_region: fiche.region,
        fiche_path: fiche.path,
      });
    }

    console.log(`   ✓ ${fiche.path} — ${faqs.length} FAQ + ${bodyChunks.length} chunks corps`);
  }
  console.log(`\n   Total chunks : ${allChunks.length}\n`);

  console.log("3. Génération des embeddings Voyage AI (voyage-multilingual-2)...");
  const BATCH_SIZE = 64;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.texte);
    const embeddings = await embedBatch(texts, VOYAGE_API_KEY, "document");
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = embeddings[j];
    }
    console.log(`   ✓ batch ${Math.floor(i / BATCH_SIZE) + 1} — ${batch.length} embeddings`);
    await sleep(300);
  }

  console.log("\n4. Écriture vers Firestore collection `fiches_chunks`...");
  const WRITE_BATCH = 400;
  for (let i = 0; i < allChunks.length; i += WRITE_BATCH) {
    const writeBatch = db.batch();
    const slice = allChunks.slice(i, i + WRITE_BATCH);
    for (const c of slice) {
      const { id, embedding, ...rest } = c;
      writeBatch.set(db.collection("fiches_chunks").doc(id), {
        ...rest,
        embedding: admin.firestore.FieldValue.vector(embedding),
        indexedAt: new Date(),
      });
    }
    await writeBatch.commit();
    console.log(`   ✓ écrit ${Math.min(i + WRITE_BATCH, allChunks.length)}/${allChunks.length}`);
  }

  console.log(`\n=== Indexation terminée : ${allChunks.length} chunks ===\n`);
  console.log("Prochaines étapes :");
  console.log("  1. Créer l'index vectoriel Firestore (firebase deploy --only firestore:indexes)");
  console.log("  2. Déployer les Functions : firebase deploy --only functions");
  console.log("  3. Tester avec : node scripts/test-query.js \"ma question\"");
}

main().catch(err => {
  console.error("\nÉCHEC :", err);
  process.exit(1);
});
