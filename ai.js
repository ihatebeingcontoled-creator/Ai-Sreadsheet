/* ai.js — real AI integration for the Outreach Ledger.
 *
 * Two things live here:
 *
 * 1. Info research ("Fetch Info" / "Generate Info" / the Info step of
 *    "Automate"): calls Groq's `groq/compound-mini` model, which has a
 *    *built-in* web-search tool, so it actually looks the company up
 *    instead of returning canned text.
 *
 *    compound_custom.tools.enabled_tools is set to just ["web_search"] below —
 *    by default compound can also reach for code execution, visiting websites,
 *    and Wolfram Alpha in the same call, and that extra tool orchestration was
 *    causing Groq to reject even tiny prompts with a 413. Restricting it to
 *    search-only keeps the real web lookup this app needs while avoiding that.
 *
 * 2. Drafting ("Draft" / "Script" / "Draft All" / the Draft step of
 *    "Automate"): calls a plain (non-search) Groq chat model. It's handed
 *    the company info that step 1 already gathered, plus whatever template
 *    is attached to that channel, and told what to do with it — write a
 *    personalized outreach message (or call script) rather than just
 *    reusing the template verbatim. No web search needed here, so a
 *    faster/cheaper model is used.
 *
 * All API keys are managed by apikeys.js (top-right status bar — the
 * "🔍 Info" pill, plus one "✏️ Draft ⋯" pill per channel). They're stored
 * only in this browser's localStorage and sent only to api.groq.com —
 * never anywhere else.
 *
 * Everything else in index.html talks to this file through two globals:
 *   window.AI.fetchCompanyInfo(companyName) -> Promise<string>
 *   window.AI.fetchDraft({ companyName, companyInfo, channel, templateText, templateSubject }) -> Promise<{ subject: string, text: string }>
 *
 * fetchDraft always resolves to a { subject, text } pair now. For Email, the
 * model is asked to write both a personalized subject line and the body in
 * one call, using a delimiter format that's parsed back apart in this file
 * (see SUBJECT_MARKER / BODY_MARKER below) — index.html then puts `subject`
 * into ch.subject and `text` into ch.sentText, and Send uses ch.subject.
 * For every other channel `subject` just comes back as "" and only `text`
 * matters (there's no subject concept for iMessage/Viber/Calls).
 */

(function () {
  const INFO_SERVICE_ID = "info";
  // one drafting API key per channel — mirrors the email/imessage/viber/calling split
  // already used for sending (see CHANNEL_SERVICE_ID in index.html)
  const CHANNEL_DRAFT_SERVICE = {
    Email: { id: "draftEmail", icon: "\u270F\uFE0F", short: "Draft Email" },
    iMessage: { id: "draftIMessage", icon: "\u270F\uFE0F", short: "Draft SMS" },
    Viber: { id: "draftViber", icon: "\u270F\uFE0F", short: "Draft Viber" },
    Calls: { id: "draftCalls", icon: "\u270F\uFE0F", short: "Draft Calls" },
  };
  const GROQ_MODEL = "groq/compound-mini"; // has built-in web search, so it can research a real company
  const GROQ_DRAFT_MODEL = "llama-3.3-70b-versatile"; // plain model, no search tool — just writes the message
  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

  function isConfigured() {
    return !!(window.APIKeys && window.APIKeys.hasActiveKey(INFO_SERVICE_ID));
  }

  // shared low-level caller: posts one user-turn prompt to Groq with the given
  // key + model, and returns the plain-text reply. Both fetchCompanyInfo and
  // fetchDraft build a prompt and hand it to this.
  //
  // `debug`, if passed, is an object this function fills in as it goes:
  //   debug.request  -> the exact JSON body sent to Groq (pretty-printed)
  //   debug.response -> the raw HTTP status + body Groq sent back, on success
  //                      OR on failure (network error, 401, 413, anything) —
  //                      whatever actually happened, not just the friendly
  //                      Error message. This is what the "Input"/"Output"
  //                      boxes in the AI modal show, so it's always the real
  //                      wire traffic, never a hand-typed note.
  async function callGroq(key, model, prompt, notConfiguredService, debug) {
    const requestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
    if (debug) debug.request = JSON.stringify(requestBody, null, 2);

    let res;
    try {
      res = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      if (debug) debug.response = "Network error \u2014 the request never got a response:\n" + networkErr.message;
      throw new Error("Network error reaching Groq: " + networkErr.message);
    }

    const rawText = await res.text().catch(() => "");
    if (debug) debug.response = `HTTP ${res.status} ${res.statusText}\n\n${rawText}`;

    if (!res.ok) {
      let detail = "";
      try {
        const errJson = JSON.parse(rawText);
        detail = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
      } catch (e) {
        detail = rawText;
      }
      if (res.status === 401) {
        throw new Error(
          `Groq rejected the API key (401). Click the ${notConfiguredService.icon} ${notConfiguredService.short} button (top right) to check or switch it.`
        );
      }
      if (res.status === 413) {
        throw new Error(
          "Groq rejected the request as too large (413). Try again with a shorter template/info, " +
            "or switch the model used in ai.js."
        );
      }
      throw new Error(`Groq API error ${res.status}: ${detail || "request failed"}`);
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error("Groq returned a response that wasn't valid JSON.");
    }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Groq returned an empty response.");
    return text.trim();
  }

  // Delimiters the Email prompt asks the model to wrap its subject/body in,
  // and the matching parser. Using unlikely-to-collide markers (rather than
  // asking for raw JSON) because the body is free-form multi-line text and
  // models are much more reliable at echoing back a literal marker line than
  // at producing valid escaped JSON for a long paragraph.
  const SUBJECT_MARKER = "===SUBJECT===";
  const BODY_MARKER = "===BODY===";

  // Pulls { subject, text } back out of a SUBJECT_MARKER/BODY_MARKER-formatted
  // reply. Falls back gracefully if the model didn't follow the format
  // exactly (still returns something usable rather than throwing), so a
  // slightly-off model reply degrades to "whole thing goes in the body"
  // instead of failing the draft entirely.
  function parseSubjectAndBody(raw) {
    const subjIdx = raw.indexOf(SUBJECT_MARKER);
    const bodyIdx = raw.indexOf(BODY_MARKER);
    if (subjIdx === -1 || bodyIdx === -1 || bodyIdx < subjIdx) {
      return { subject: "", text: raw.trim() };
    }
    const subject = raw.slice(subjIdx + SUBJECT_MARKER.length, bodyIdx).trim();
    const text = raw.slice(bodyIdx + BODY_MARKER.length).trim();
    return { subject, text: text || raw.trim() };
  }

  async function fetchCompanyInfo(companyName, researchTemplateText, debug) {
    const key = window.APIKeys ? window.APIKeys.getActiveKey(INFO_SERVICE_ID) : "";
    if (!key) {
      if (window.APIKeys) window.APIKeys.openManager(INFO_SERVICE_ID);
      throw new Error(
        "No Info Research API key set yet. Click the \uD83D\uDD0D Info button (top right) to add one."
      );
    }

    // if an "Info" template is attached, use its text as the actual research
    // brief (it can call out specific things to look for); otherwise fall
    // back to the generic overview brief.
    const brief =
      researchTemplateText && researchTemplateText.trim()
        ? researchTemplateText.trim().replace(/\{\{\s*company\s*\}\}/gi, companyName)
        : `Research {{company}}: summarize what they do, their key products or services, their specialties, ` +
          `their main competitors, target market/customers, company size, and any recent news.`.replace(
            /\{\{\s*company\s*\}\}/gi,
            companyName
          );

    const prompt =
      `Research the real company/business named "${companyName}". Use web search to find out ` +
      `what they actually do. ${brief} ` +
      `Reply in short plain-text lines (no markdown symbols), clearly labeled sections. ` +
      `If you can't find a real business by this name, say so plainly instead of inventing details.`;

    return callGroq(key, GROQ_MODEL, prompt, { icon: "\uD83D\uDD0D", short: "Info" }, debug);
  }

  /* fetchDraft — writes the actual outreach message/call-script text.
   * Inputs:
   *   companyName    - the company being contacted
   *   companyInfo    - the research text already produced by fetchCompanyInfo
   *   channel        - "Email" | "iMessage" | "Viber" | "Calls"
   *   templateText   - the attached template's body text (instructions/example
   *                     for tone & content — may be empty if nothing's attached)
   *   templateSubject- the attached template's subject line, Email only (may be empty)
   *   language       - optional language name (from the channel's Language field)
   *                     to write the draft in \u2014 e.g. "Lithuanian". Empty/omitted
   *                     means no instruction is added and the model picks its default.
   * Output: { subject, text }. For Email, subject is the AI-personalized subject
   * line and text is the body (subject is never repeated inside the body). For
   * every other channel subject is "" and text is the message body / call script.
   */
  async function fetchDraft({ companyName, companyInfo, channel, templateText, templateSubject, language }, debug) {
    const svc = CHANNEL_DRAFT_SERVICE[channel];
    if (!svc) throw new Error(`Unknown channel "${channel}" \u2014 no drafting service configured for it.`);

    const key = window.APIKeys ? window.APIKeys.getActiveKey(svc.id) : "";
    if (!key) {
      if (window.APIKeys) window.APIKeys.openManager(svc.id);
      throw new Error(
        `No ${channel} Drafting AI key set yet. Click the ${svc.icon} ${svc.short} button (top right) to add one.`
      );
    }

    const isCall = channel === "Calls";
    const fill = (s) => (s || "").replace(/\{\{\s*company\s*\}\}/gi, companyName);
    const lang = (language && language.trim()) || "";

    const parts = [
      `You are writing a personalized ${isCall ? "cold-call script" : channel + " outreach message"} ` +
        `to send to the real company "${companyName}".`,
    ];

    // The language instruction goes early, in its own strongly-worded paragraph,
    // and gets repeated at the end. Models like llama-3.3-70b-versatile tend to
    // default to whatever language the template/company-info text below happens
    // to be written in (usually English) unless this is impossible to miss —
    // one quiet mention at the very end of a long prompt was getting overridden
    // by the English template text that comes right before it.
    if (lang) {
      parts.push(
        `CRITICAL LANGUAGE REQUIREMENT: Write your entire response in ${lang}, and ONLY in ${lang}. ` +
          `This applies no matter what language the research notes or template below are written in \u2014 ` +
          `translate/adapt their content into ${lang}, don't just copy their English wording. ` +
          `Do not mix in English words or sentences.`
      );
    }

    parts.push(
      `Here is what's known about this company, from research:\n${companyInfo ? fill(companyInfo) : "(no research notes available)"}`
    );

    if (templateText && templateText.trim()) {
      parts.push(
        `Use the following as a template/guide for tone, structure, and the key points to include. ` +
          `Personalize it for this specific company using the research above \u2014 don't just copy it verbatim, ` +
          `adapt it so it clearly references something true about this company` +
          (lang ? ` (and remember: write it in ${lang}, even though this template is in English)` : "") +
          `:\n${fill(templateText)}`
      );
    } else {
      parts.push(
        `No template is attached, so write a short, natural, friendly outreach message from scratch that references something specific about the company.`
      );
    }

    const isEmail = channel === "Email";

    if (isCall) {
      parts.push(
        `Write only the final call script \u2014 what to actually say out loud on the phone, 3\u20136 sentences, ` +
          `natural spoken language. Plain text only. No labels, no markdown, no stage directions, no explanations.`
      );
    } else if (isEmail) {
      parts.push(
        `Write a personalized subject line AND the message body \u2014 both should reference something ` +
          `specific and true about this company, not be generic.` +
          (templateSubject ? ` Use this as a guide/starting point for the subject: "${fill(templateSubject)}".` : "") +
          `\n\nReply in EXACTLY this format and nothing else \u2014 no preamble, no markdown, no extra commentary ` +
          `before or after:\n\n${SUBJECT_MARKER}\n<the subject line, one line, plain text>\n${BODY_MARKER}\n` +
          `<the full email body, plain text, no labels, no placeholders left unfilled>`
      );
    } else {
      parts.push(
        `Write only the final message body text. Plain text only \u2014 no labels, ` +
          `no markdown, no explanations, no placeholders left unfilled.`
      );
    }

    // repeated one final time, last thing the model reads, as a last-resort catch
    if (lang) {
      parts.push(`Reminder: the entire output must be written in ${lang}.`);
    }

    const prompt = parts.join("\n\n");
    const raw = await callGroq(key, GROQ_DRAFT_MODEL, prompt, svc, debug);
    return isEmail ? parseSubjectAndBody(raw) : { subject: "", text: raw };
  }

  window.AI = { isConfigured, fetchCompanyInfo, fetchDraft };
})();
