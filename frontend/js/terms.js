// PeterParker Terms of Service, shown (and agreed to) when creating an account.
// Bump TERMS_VERSION whenever the text changes; the server records which version each
// account accepted and rejects sign-ups that send an old one
// (backend/app/api/routes/auth.py, TERMS_VERSION).

export const TERMS_VERSION = "2026-10-17.2";
export const TERMS_EFFECTIVE = "October 17, 2026";

// [heading, paragraphs[]]. Plain text only; rendered with textContent.
export const TERMS_SECTIONS = [
  [
    "1. Agreement to these Terms",
    [
      "These Terms of Service (the “Terms”) are a legally binding agreement between you and the student developers who operate PeterParker (“PeterParker,” “we,” “us”). By checking the box and creating an account, or by using PeterParker in any way, you agree to these Terms. If you do not agree, do not create an account or use PeterParker.",
      "You must be at least 18 years old, or have the permission of a parent or legal guardian, and have a valid email address to create an account. UCI parking permit features are available only to accounts with a UC Irvine email address; using a UCI email does not mean you hold a permit, and you are responsible for choosing the permit you actually have.",
    ],
  ],
  [
    "2. Not affiliated with UC Irvine",
    [
      "PeterParker is an independent student project. It is not operated, sponsored, endorsed or reviewed by the University of California, the Regents of the University of California, UC Irvine, UCI Transportation, or any parking operator, property owner or shopping center shown on the map. Names and logos are used only to identify places.",
    ],
  ],
  [
    "3. Information is for general guidance only",
    [
      "Parking locations, categories, permit rules, zones, hours, prices, space counts, accessible and EV stall counts, “open now” figures, reviews, routes and walking times are compiled from public sources (including OpenStreetMap, UC Irvine web pages and user contributions). They may be incomplete, out of date or wrong. “Open now” numbers are typical estimates, not live counts.",
      "Posted signs, curb markings, parking officers and the official rules of the lot owner always control. You are solely responsible for confirming where, when and how you may legally park, holding a valid permit or paying any fee, and obeying time limits and restrictions.",
    ],
  ],
  [
    "4. You are responsible for your parking",
    [
      "We are not responsible for any parking citation, fine, fee, boot, tow, impound or storage charge, permit revocation, disciplinary action, or any other consequence that results from where or how you park or travel, even if you relied on information in PeterParker.",
      "Lots marked “Limited / may be towed” or private are shown so you know the risk, not as an invitation to park there.",
    ],
  ],
  [
    "5. Safe and lawful use of navigation",
    [
      "Do not look at or operate PeterParker while driving. Set your route before you start, or let a passenger use it. Always obey traffic laws, road signs and closures, and use your own judgment; routes may be unsafe, closed or unsuitable for your vehicle, or walking paths may be poorly lit. You use directions at your own risk.",
      "Be aware of your surroundings when walking to or from parking, especially at night. In an emergency, call 911 (UCI Police: 949-824-5223).",
    ],
  ],
  [
    "6. Your account",
    [
      "Keep your password secret and your information accurate. You are responsible for everything done with your account. Tell us promptly if you believe your account has been used without permission. One person, one account.",
    ],
  ],
  [
    "7. Reviews, replies and reports",
    [
      "You are responsible for anything you post. Post only honest, first-hand information. Do not post anything unlawful, harassing, hateful, threatening, sexually explicit, defamatory or misleading; personal information about others (including license plates); spam or advertising; or anything you do not have the right to share.",
      "You keep ownership of your posts, but you give PeterParker a non-exclusive, royalty-free, worldwide license to store, display, reproduce and adapt them to operate and improve the app. Other users’ posts are their own opinions, not ours. We may remove any content or suspend any account at our discretion.",
    ],
  ],
  [
    "8. Location and privacy",
    [
      "If you allow it, your browser shares your current location so we can show where you are and plan routes. Location is used only while the map is open and is not stored with your account. To plan a route, start and end points are sent to a third-party routing service (by default routing.openstreetmap.de).",
      "We store your email, username, password (as a secure hash), profile picture and colors, permit type, saved places, reviews and reports, and the date you accepted these Terms. We do not sell your information. You can delete your account in Settings, which removes your account data. Do not upload a profile picture of anyone else without their permission.",
    ],
  ],
  [
    "9. Acceptable use",
    [
      "Do not misuse PeterParker: no attempts to break or overload it, access other people’s accounts or data, scrape it in bulk, get around its security, or use it for anything illegal. Map data © OpenStreetMap contributors and is available under the Open Database License.",
    ],
  ],
  [
    "10. No warranty",
    [
      "PeterParker is provided “AS IS” and “AS AVAILABLE,” without warranties of any kind, express or implied, including any warranty of accuracy, availability, merchantability, fitness for a particular purpose or non-infringement. We do not promise that PeterParker will be uninterrupted, secure or error-free, or that any parking space will be available.",
    ],
  ],
  [
    "11. Limitation of liability",
    [
      "To the fullest extent permitted by law, PeterParker and its developers will not be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of money, time, data, property, or use, or for any citation, tow, accident, injury, theft or damage to your vehicle, arising out of or related to your use of (or inability to use) PeterParker, whatever the legal theory, even if we were told such damage was possible.",
      "Our total liability for any claim relating to PeterParker is limited to the greater of the amount you paid us to use it (PeterParker is free, so normally $0) or $10. Some jurisdictions do not allow certain limitations, so some of these may not apply to you.",
    ],
  ],
  [
    "12. Indemnity",
    [
      "You agree to defend, indemnify and hold harmless PeterParker and its developers from any claims, damages, losses and expenses (including reasonable attorneys’ fees) arising from your use of PeterParker, your content, your parking or driving, or your breach of these Terms.",
    ],
  ],
  [
    "13. Changes and termination",
    [
      "We may change PeterParker or these Terms at any time. If we make material changes, we will ask you to accept the new Terms; continuing to use PeterParker after that means you accept them. We may suspend or end your access at any time. You may stop using PeterParker and delete your account at any time. Sections 3–5 and 7–14 survive termination.",
    ],
  ],
  [
    "14. General",
    [
      "These Terms are governed by the laws of the State of California, without regard to conflict-of-law rules, and any dispute will be resolved in the state or federal courts located in Orange County, California. If any part of these Terms is found unenforceable, the rest stays in effect. Our failure to enforce a provision is not a waiver. These Terms are the entire agreement between you and us about PeterParker.",
      "Questions? Use “Report issue” in the app.",
    ],
  ],
];

// Fills `container` with the Terms as headings and paragraphs.
export function renderTerms(container) {
  const nodes = [];
  const meta = document.createElement("p");
  meta.className = "terms-meta";
  meta.textContent = `Effective ${TERMS_EFFECTIVE} · Version ${TERMS_VERSION}`;
  nodes.push(meta);
  for (const [heading, paragraphs] of TERMS_SECTIONS) {
    const h = document.createElement("h3");
    h.textContent = heading;
    nodes.push(h);
    for (const text of paragraphs) {
      const p = document.createElement("p");
      p.textContent = text;
      nodes.push(p);
    }
  }
  container.replaceChildren(...nodes);
}
