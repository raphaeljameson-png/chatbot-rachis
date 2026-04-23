/**
 * widget.js — Assistant d'information EFR
 * Version : 1.0.0
 *
 * Intégration : ajouter dans <body> :
 *   <script src="https://.../widget.js"
 *           data-api-url="https://europe-west1-PROJECT.cloudfunctions.net/askChatbot"
 *           data-context="default"
 *           defer></script>
 *
 * Configurable via data-attributes sur le tag script :
 *   data-api-url   : URL de la Firebase Function askChatbot (obligatoire)
 *   data-context   : contexte d'entrée (optionnel : default, preop-admin, postop-hernie, postop-lombaire, kine)
 *   data-auto-open : "true" pour ouvrir automatiquement (pratique pour QR codes)
 *
 * L'auto-open peut aussi être déclenché par ?chat=open dans l'URL de la page.
 *
 * Le widget crée un bouton flottant + une fenêtre de chat.
 * Sur mobile (≤ 640px) la fenêtre s'affiche en plein écran.
 * Sur desktop, la fenêtre est flottante en bas à droite.
 */

(function () {
  "use strict";

  // ─── Configuration lue depuis le tag <script> ──────────────────────────
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();
  const API_URL = currentScript.dataset.apiUrl || "";
  const CONTEXT = currentScript.dataset.context || "default";
  const AUTO_OPEN = currentScript.dataset.autoOpen === "true" || new URLSearchParams(window.location.search).get("chat") === "open";

  if (!API_URL) {
    console.error("[EFR Chatbot] data-api-url manquante sur le tag script, widget désactivé.");
    return;
  }

  // ─── Session ID stable (stocké dans sessionStorage) ─────────────────────
  function getSessionId() {
    let sid = null;
    try { sid = sessionStorage.getItem("efr_chat_sid"); } catch (e) {}
    if (!sid) {
      sid = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { sessionStorage.setItem("efr_chat_sid", sid); } catch (e) {}
    }
    return sid;
  }
  const SESSION_ID = getSessionId();

  // ─── Historique conversation (in-memory, pas de persistence) ───────────
  const history = [];

  // ─── Suggestions par contexte ──────────────────────────────────────────
  const SUGGESTIONS = {
    default: [
      "Quels documents apporter le jour de l'opération ?",
      "Comment se déroule la consultation d'anesthésie ?",
      "Quand reprendre la conduite après l'opération ?",
    ],
    "preop-admin": [
      "Quels documents apporter le jour J ?",
      "Jusqu'à quelle heure puis-je manger la veille ?",
      "Je dois arrêter mes anticoagulants ?",
    ],
    "postop-hernie": [
      "Comment surveiller ma cicatrice ?",
      "Quand reprendre la marche et le sport ?",
      "Quels signes doivent m'alerter ?",
    ],
    "postop-lombaire": [
      "Comment soigner ma cicatrice ?",
      "Quand reprendre le travail ?",
      "Quelle rééducation après l'opération ?",
    ],
    "kine": [
      "Quand démarrer la rééducation ?",
      "Quels exercices faire à la maison ?",
      "Quelle ordonnance de kinésithérapie ?",
    ],
  };
  const currentSuggestions = SUGGESTIONS[CONTEXT] || SUGGESTIONS.default;

  // ─── CSS injecté ────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .efr-chat-bubble {
      position: fixed; bottom: 20px; right: 20px; z-index: 999998;
      width: 60px; height: 60px; border-radius: 50%;
      background: #0b6fa4; border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(11, 111, 164, 0.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .efr-chat-bubble:hover { transform: scale(1.06); box-shadow: 0 6px 20px rgba(11, 111, 164, 0.45); }
    .efr-chat-bubble:active { transform: scale(0.96); }
    .efr-chat-bubble svg { width: 26px; height: 26px; }
    .efr-chat-bubble-dot {
      position: absolute; top: 2px; right: 2px;
      width: 14px; height: 14px; background: #22b8b8;
      border-radius: 50%; border: 2px solid #fff;
    }
    .efr-chat-window {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      width: 380px; height: 560px; max-height: calc(100vh - 40px);
      background: #fff; border-radius: 16px;
      border: 0.5px solid #d9d9d9;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .efr-chat-window.efr-open { display: flex; }
    .efr-chat-header {
      background: #0b6fa4; color: #fff; padding: 12px 14px;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    .efr-chat-header-inner { display: flex; align-items: center; gap: 10px; }
    .efr-chat-header-logo {
      width: 32px; height: 32px; background: rgba(255,255,255,0.15);
      border-radius: 6px; display: flex; align-items: center;
      justify-content: center; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
    }
    .efr-chat-header-title { font-size: 13px; font-weight: 600; line-height: 1.2; }
    .efr-chat-header-subtitle {
      font-size: 11px; opacity: 0.85; display: flex; align-items: center; gap: 5px; line-height: 1.2;
    }
    .efr-chat-header-subtitle::before {
      content: ""; width: 6px; height: 6px; background: #22b8b8;
      border-radius: 50%; display: inline-block;
    }
    .efr-chat-close {
      background: transparent; border: none; color: #fff; cursor: pointer;
      padding: 4px; display: flex; align-items: center; justify-content: center;
      border-radius: 4px; -webkit-tap-highlight-color: transparent;
    }
    .efr-chat-close:hover { background: rgba(255,255,255,0.1); }
    .efr-chat-close svg { width: 20px; height: 20px; }
    .efr-chat-messages {
      flex: 1; overflow-y: auto; padding: 14px;
      background: #fafbfc; display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
    }
    .efr-msg {
      max-width: 85%; padding: 9px 12px; font-size: 14px;
      line-height: 1.5; word-wrap: break-word;
    }
    .efr-msg-user {
      align-self: flex-end; background: #0b6fa4; color: #fff;
      border-radius: 14px 14px 4px 14px; white-space: pre-wrap;
    }
    .efr-msg-bot {
      align-self: flex-start; background: #fff; color: #222;
      border: 0.5px solid #e5e7eb; border-radius: 14px 14px 14px 4px;
    }
    .efr-msg-bot a {
      color: #0b6fa4; text-decoration: underline; font-weight: 500;
    }
    .efr-msg-bot strong { font-weight: 600; }
    .efr-msg-bot ul { margin: 6px 0; padding-left: 20px; }
    .efr-msg-bot li { margin: 2px 0; }
    .efr-msg-bot p { margin: 0 0 8px 0; }
    .efr-msg-bot p:last-child { margin-bottom: 0; }
    .efr-typing {
      align-self: flex-start; background: #fff; padding: 12px 14px;
      border-radius: 14px; border: 0.5px solid #e5e7eb;
      display: flex; gap: 4px; align-items: center;
    }
    .efr-typing span {
      width: 7px; height: 7px; background: #999; border-radius: 50%;
      animation: efrDot 1.4s infinite ease-in-out both;
    }
    .efr-typing span:nth-child(2) { animation-delay: 0.2s; }
    .efr-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes efrDot {
      0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-4px); }
    }
    .efr-suggestions {
      padding: 10px 14px; border-top: 0.5px solid #e5e7eb;
      background: #fff; display: flex; flex-direction: column; gap: 6px;
      flex-shrink: 0;
    }
    .efr-suggestions-title {
      font-size: 10px; color: #888; text-transform: uppercase;
      letter-spacing: 0.5px; font-weight: 600; margin-bottom: 2px;
    }
    .efr-suggestion {
      text-align: left; background: #f3f5f7; border: 0.5px solid #e5e7eb;
      border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #333;
      cursor: pointer; font-family: inherit; line-height: 1.4;
      transition: background 0.15s; -webkit-tap-highlight-color: transparent;
    }
    .efr-suggestion:hover { background: #e8ebef; }
    .efr-suggestion:active { background: #dce0e5; }
    .efr-input-wrap {
      border-top: 0.5px solid #e5e7eb; padding: 10px 12px;
      background: #fff; display: flex; gap: 8px; align-items: center;
      flex-shrink: 0;
    }
    .efr-input {
      flex: 1; border: 0.5px solid #d9d9d9; border-radius: 20px;
      padding: 8px 14px; font-size: 14px; outline: none;
      font-family: inherit; background: #fafbfc; color: #222;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .efr-input:focus {
      border-color: #0b6fa4;
      box-shadow: 0 0 0 3px rgba(11, 111, 164, 0.12);
      background: #fff;
    }
    .efr-send {
      background: #0b6fa4; border: none; width: 36px; height: 36px;
      border-radius: 50%; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
    }
    .efr-send:hover { background: #085a87; }
    .efr-send:active { transform: scale(0.94); }
    .efr-send:disabled { background: #888; cursor: not-allowed; }
    .efr-send svg { width: 16px; height: 16px; }
    .efr-footer {
      font-size: 10px; color: #888; text-align: center;
      padding: 6px; background: #f3f5f7;
      border-top: 0.5px solid #e5e7eb;
    }
    @media (max-width: 640px) {
      .efr-chat-bubble { width: 56px; height: 56px; bottom: 16px; right: 16px; }
      .efr-chat-bubble svg { width: 22px; height: 22px; }
      .efr-chat-window {
        bottom: 0; right: 0; top: 0; left: 0;
        width: 100%; height: 100%; max-height: 100%;
        border-radius: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .efr-chat-bubble, .efr-send, .efr-suggestion, .efr-chat-messages { transition: none; }
      .efr-typing span { animation: none; }
    }
  `;
  document.head.appendChild(style);

  // ─── HTML structure ─────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "efr-chat-root";
  root.innerHTML = `
    <button class="efr-chat-bubble" aria-label="Ouvrir l'assistant d'information EFR" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="efr-chat-bubble-dot" aria-hidden="true"></span>
    </button>
    <div class="efr-chat-window" role="dialog" aria-label="Assistant d'information EFR" aria-modal="false">
      <div class="efr-chat-header">
        <div class="efr-chat-header-inner">
          <div class="efr-chat-header-logo">EFR</div>
          <div>
            <div class="efr-chat-header-title">Assistant d'information</div>
            <div class="efr-chat-header-subtitle">En ligne</div>
          </div>
        </div>
        <button class="efr-chat-close" aria-label="Fermer l'assistant" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="efr-chat-messages" id="efr-msg-list" aria-live="polite"></div>
      <div class="efr-suggestions" id="efr-suggestions">
        <div class="efr-suggestions-title">Questions fréquentes</div>
      </div>
      <div class="efr-input-wrap">
        <input type="text" class="efr-input" id="efr-input" placeholder="Posez votre question…" maxlength="1000" aria-label="Votre question">
        <button class="efr-send" id="efr-send" aria-label="Envoyer" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="efr-footer">Assistant d'information · Ne remplace pas l'avis médical</div>
    </div>
  `;
  document.body.appendChild(root);

  // ─── Récupération des éléments DOM ─────────────────────────────────────
  const bubble = root.querySelector(".efr-chat-bubble");
  const windowEl = root.querySelector(".efr-chat-window");
  const closeBtn = root.querySelector(".efr-chat-close");
  const msgList = root.querySelector("#efr-msg-list");
  const input = root.querySelector("#efr-input");
  const sendBtn = root.querySelector("#efr-send");
  const suggestionsEl = root.querySelector("#efr-suggestions");

  // ─── Rendu des suggestions ─────────────────────────────────────────────
  function renderSuggestions() {
    const existingBtns = suggestionsEl.querySelectorAll(".efr-suggestion");
    existingBtns.forEach(b => b.remove());
    currentSuggestions.forEach(s => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "efr-suggestion";
      btn.textContent = s;
      btn.addEventListener("click", () => ask(s));
      suggestionsEl.appendChild(btn);
    });
  }
  renderSuggestions();

  // ─── Gestion ouverture/fermeture ───────────────────────────────────────
  let isOpen = false;
  let firstOpen = true;

  function openChat() {
    isOpen = true;
    windowEl.classList.add("efr-open");
    bubble.style.display = "none";
    if (firstOpen) {
      firstOpen = false;
      addBotMessage(
        "Bonjour. Je suis l'assistant d'information de l'Espace Francilien du Rachis.\n\n" +
        "Je peux vous aider sur les démarches administratives et les consignes générales de votre parcours de soins.\n\n" +
        "⚠ Pour toute question personnelle sur votre santé, contactez directement le secrétariat."
      );
    }
    setTimeout(() => input.focus(), 100);
  }
  function closeChat() {
    isOpen = false;
    windowEl.classList.remove("efr-open");
    bubble.style.display = "flex";
  }
  bubble.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeChat();
  });

  if (AUTO_OPEN) {
    setTimeout(openChat, 500);
  }

  // ─── Markdown minimal sécurisé ─────────────────────────────────────────
  // Supporte : **gras**, [texte](url) vers http(s), listes à puces (•/-/*)
  // et paragraphes séparés par des sauts de ligne doubles.
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  function renderInline(text) {
    // Échapper d'abord, puis réintroduire liens et gras sûrs.
    let html = escapeHtml(text);
    // Liens [texte](url) avec URL http(s) uniquement
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`
    );
    // Gras **texte**
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    return html;
  }
  function renderMarkdown(text) {
    // Découpe en blocs séparés par lignes vides.
    const blocks = String(text).replace(/\r\n/g, "\n").split(/\n{2,}/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      // Bloc de type liste si TOUTES les lignes non vides commencent par • ou - ou *
      const bulletLines = lines.filter(l => l.trim().length > 0);
      const isList = bulletLines.length > 0 && bulletLines.every(l => /^\s*[-•*]\s+/.test(l));
      if (isList) {
        out.push("<ul>");
        for (const l of bulletLines) {
          const content = l.replace(/^\s*[-•*]\s+/, "");
          out.push(`<li>${renderInline(content)}</li>`);
        }
        out.push("</ul>");
      } else {
        // Paragraphe : on garde les retours à la ligne simples comme <br>
        const paraHtml = lines
          .filter(l => l.length > 0)
          .map(l => renderInline(l))
          .join("<br>");
        if (paraHtml) out.push(`<p>${paraHtml}</p>`);
      }
    }
    return out.join("");
  }
  function addUserMessage(text) {
    const div = document.createElement("div");
    div.className = "efr-msg efr-msg-user";
    div.textContent = text;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }
  function addBotMessage(text) {
    const div = document.createElement("div");
    div.className = "efr-msg efr-msg-bot";
    div.innerHTML = renderMarkdown(text);
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }
  function addTyping() {
    const div = document.createElement("div");
    div.className = "efr-typing";
    div.id = "efr-typing-indicator";
    div.innerHTML = "<span></span><span></span><span></span>";
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }
  function removeTyping() {
    const el = document.getElementById("efr-typing-indicator");
    if (el) el.remove();
  }

  // ─── Appel API ─────────────────────────────────────────────────────────
  let isBusy = false;
  async function ask(question) {
    if (isBusy) return;
    const q = String(question || "").trim();
    if (q.length < 2) return;
    isBusy = true;
    sendBtn.disabled = true;
    input.value = "";
    addUserMessage(q);
    suggestionsEl.style.display = "none";
    addTyping();

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          sessionId: SESSION_ID,
          history: history,
        }),
      });
      removeTyping();

      if (resp.status === 429) {
        addBotMessage("Vous avez atteint la limite quotidienne de 30 questions. Pour toute nouvelle question, merci de contacter directement le secrétariat.");
        return;
      }
      if (!resp.ok) {
        addBotMessage("Une erreur est survenue. Réessayez dans quelques instants. Si le problème persiste, contactez le secrétariat.");
        return;
      }
      const data = await resp.json();
      const reponse = data.reponse || "Désolé, je n'ai pas pu formuler de réponse.";

      history.push({ role: "user", content: q });
      history.push({ role: "assistant", content: reponse });
      if (history.length > 12) history.splice(0, history.length - 12);

      addBotMessage(reponse);
    } catch (err) {
      removeTyping();
      console.error("[EFR Chatbot] fetch error:", err);
      addBotMessage("Impossible de joindre l'assistant pour le moment. Vérifiez votre connexion internet ou contactez le secrétariat.");
    } finally {
      isBusy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", () => ask(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input.value);
    }
  });
})();
