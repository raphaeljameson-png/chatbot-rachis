/**
 * scripts/debug-check-chunks.js
 * Diagnostique l'état des chunks Firestore et teste la requête filtrée.
 * Usage : node debug-check-chunks.js [fiche_path]
 * Exemple : node debug-check-chunks.js cervical/acdf.html
 */

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

// Service account ou ADC
const saPath = path.join(__dirname, "../firebase-service-account.json");
if (fs.existsSync(saPath)) {
  const sa = require(saPath);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  console.log("✓ Authentification via firebase-service-account.json");
} else {
  admin.initializeApp(); // gcloud auth application-default login
  console.log("✓ Authentification via Application Default Credentials");
}

const db = admin.firestore();
const TARGET = process.argv[2] || "cervical/acdf.html";

async function main() {
  console.log(`\n=== DEBUG fiches_chunks — cible : "${TARGET}" ===\n`);

  // 1. Compter les chunks totaux
  const totalSnap = await db.collection("fiches_chunks").count().get();
  console.log(`Total chunks : ${totalSnap.data().count}`);

  // 2. Compter les chunks pour la fiche cible
  const ficheSnap = await db.collection("fiches_chunks")
    .where("fiche_path", "==", TARGET)
    .count()
    .get();
  console.log(`Chunks avec fiche_path == "${TARGET}" : ${ficheSnap.data().count}`);

  // 3. Lister les valeurs distinctes de fiche_path (fetch all, unique en mémoire)
  console.log("\n--- Valeurs distinctes de fiche_path ---");
  const allSnap = await db.collection("fiches_chunks")
    .select("fiche_path", "fiche_titre")
    .get();
  const paths = {};
  allSnap.docs.forEach(d => {
    const p = d.data().fiche_path;
    paths[p] = (paths[p] || 0) + 1;
  });
  const sorted = Object.entries(paths).sort((a, b) => a[0].localeCompare(b[0]));
  sorted.forEach(([p, n]) => console.log(`  ${n.toString().padStart(3)} chunks — "${p}"`));

  // 4. Tester findNearest filtré (révèle l'erreur d'index manquant)
  console.log(`\n--- Test findNearest avec .where("fiche_path","==","${TARGET}") ---`);
  const DUMMY_VEC = new Array(1024).fill(0);
  DUMMY_VEC[0] = 1; // vecteur non nul
  try {
    const snap = await db.collection("fiches_chunks")
      .where("fiche_path", "==", TARGET)
      .findNearest({
        vectorField: "embedding",
        queryVector: admin.firestore.FieldValue.vector(DUMMY_VEC),
        limit: 4,
        distanceMeasure: "COSINE",
      })
      .get();
    console.log(`✓ findNearest filtré OK — ${snap.docs.length} résultats`);
    snap.docs.forEach(d => console.log(`  - ${d.id} (${d.data().type})`));
  } catch (err) {
    console.error(`✗ findNearest filtré ERREUR : ${err.message}`);
    if (err.message.includes("index") || err.message.includes("Index")) {
      console.log("  → Cause confirmée : index composite manquant.");
    }
  }

  // 5. Test findNearest global (doit fonctionner)
  console.log("\n--- Test findNearest global (sans filtre) ---");
  try {
    const snap = await db.collection("fiches_chunks")
      .findNearest({
        vectorField: "embedding",
        queryVector: admin.firestore.FieldValue.vector(DUMMY_VEC),
        limit: 4,
        distanceMeasure: "COSINE",
      })
      .get();
    console.log(`✓ findNearest global OK — ${snap.docs.length} résultats`);
    snap.docs.forEach(d => console.log(`  - ${d.id} scope:${d.data().fiche_path}`));
  } catch (err) {
    console.error(`✗ findNearest global ERREUR : ${err.message}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
