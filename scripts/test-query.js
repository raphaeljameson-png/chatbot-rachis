/**
 * test-query.js — Test local de la recherche vectorielle
 *
 * Usage :
 *   VOYAGE_API_KEY=pa-xxx \
 *   GOOGLE_APPLICATION_CREDENTIALS=/chemin/vers/service-account.json \
 *   node scripts/test-query.js "ma question ici"
 *
 * Affiche les 5 chunks les plus pertinents avec leur source.
 * Sert à valider que l'indexation fonctionne avant de tester le chatbot complet.
 */

const admin = require("firebase-admin");

async function embedQuery(query, voyageKey) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${voyageKey}`,
    },
    body: JSON.stringify({
      input: [query],
      model: "voyage-multilingual-2",
      input_type: "query",
    }),
  });
  if (!resp.ok) throw new Error(`Voyage API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Usage : node test-query.js \"ma question\"");
    process.exit(1);
  }
  const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
  if (!VOYAGE_API_KEY) {
    console.error("ERREUR : VOYAGE_API_KEY manquante.");
    process.exit(1);
  }

  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  console.log(`\nQuestion : "${query}"\n`);
  console.log("Génération de l'embedding...");
  const emb = await embedQuery(query, VOYAGE_API_KEY);

  console.log("Recherche vectorielle Firestore...\n");
  const snap = await db.collection("fiches_chunks")
    .findNearest({
      vectorField: "embedding",
      queryVector: admin.firestore.FieldValue.vector(emb),
      limit: 5,
      distanceMeasure: "COSINE",
    })
    .get();

  console.log(`=== ${snap.size} chunks les plus pertinents ===\n`);
  snap.docs.forEach((doc, i) => {
    const d = doc.data();
    console.log(`[${i + 1}] ${d.fiche_titre} (${d.type})`);
    console.log(`    ${d.fiche_url}`);
    console.log(`    ${d.texte.slice(0, 200).replace(/\s+/g, " ")}${d.texte.length > 200 ? "..." : ""}\n`);
  });
}

main().catch(err => {
  console.error("\nÉCHEC :", err);
  process.exit(1);
});
