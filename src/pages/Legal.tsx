import { Link } from "react-router";
import { LanguageToggle, useLang } from "@/i18n";

/**
 * F3: legal pages — Terms, Privacy, Responsible Gaming.
 * Full text in English and Bangla; rendered in the active language.
 */

type Section = { h: string; p: string };

function LegalShell({ title, sections }: { title: string; sections: Section[] }) {
  const { t } = useLang();
  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="text-[#D4AF37] text-sm hover:underline">
            ← {t("backToGame")}
          </Link>
          <LanguageToggle className="border-[#3A3A4A] bg-[#12121C] text-[#D4AF37]" />
        </div>
        <h1
          className="text-3xl font-bold text-[#D4AF37] mb-6"
          style={{ fontFamily: "Cinzel, serif" }}
        >
          {title}
        </h1>
        <div className="space-y-6">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-semibold text-white mb-1">{s.h}</h2>
              <p className="text-sm leading-6 text-[#B8B8C8]">{s.p}</p>
            </section>
          ))}
        </div>
        <div className="mt-10 pt-6 border-t border-[#2A2A35] flex gap-4 text-xs text-[#8A8AA0]">
          <Link to="/terms" className="hover:text-[#D4AF37]">{t("termsTitle")}</Link>
          <Link to="/privacy" className="hover:text-[#D4AF37]">{t("privacyTitle")}</Link>
          <Link to="/responsible-gaming" className="hover:text-[#D4AF37]">{t("rgTitle")}</Link>
        </div>
      </div>
    </div>
  );
}

const TERMS: Record<"en" | "bn", Section[]> = {
  en: [
    { h: "1. Eligibility", p: "You must be at least 18 years old (or the legal gambling age in your jurisdiction, whichever is higher) to open an account or play. One account per person. Accounts found to be duplicates or operated by underage users will be closed." },
    { h: "2. The game", p: "Zeus Thunder Slots is a 5-reel, 20-line slot game. Every spin outcome is generated from a provably-fair hash of the server seed, your client seed and a nonce; the server seed hash is shown before you play and any spin can be verified afterwards in the Fairness panel. The declared return to player (RTP) is 96.0% for the standard configuration." },
    { h: "3. Deposits and withdrawals", p: "Deposits are made using the instructions shown in the Wallet (Binance PayID). A deposit is credited after review and confirmation. Withdrawals are reviewed manually for security; we may request identity verification before paying out large amounts. Minimum and maximum amounts are shown in the Wallet and can be changed from the admin panel." },
    { h: "4. Balances and errors", p: "Your balance is kept in an exact ledger. If a technical error credits or debits an incorrect amount, we will correct the ledger to the true result of the affected spins and notify affected players. Bets placed after a game has entered maintenance mode may be voided and refunded." },
    { h: "5. Fair play", p: "Bots, automated play, exploitation of bugs, collusion and abuse of bonuses or referral systems are prohibited. Accounts engaged in these activities may be suspended and winnings obtained through them voided." },
    { h: "6. Responsible gaming", p: "You can set daily deposit and loss limits, session limits and self-exclusion periods at any time in Settings. Self-exclusion cannot be cancelled early. Gambling should be entertainment, never a way to make money or recover losses." },
    { h: "7. Liability", p: "The game is provided as-is. To the maximum extent permitted by law, our liability is limited to the balance held in your account. Nothing in these terms removes rights you have under applicable consumer law." },
    { h: "8. Changes", p: "We may update these terms; material changes will be announced in the game. Continued play after an announcement constitutes acceptance." },
  ],
  bn: [
    { h: "১. যোগ্যতা", p: "অ্যাকাউন্ট খুলতে বা খেলতে আপনার বয়স কমপক্ষে ১৮ বছর হতে হবে (অথবা আপনার এলাকার আইনি জুয়া খেলার বয়স, যেটি বেশি)। প্রতি ব্যক্তির একটি মাত্র অ্যাকাউন্ট। ডুপ্লিকেট বা অপ্রাপ্তবয়স্কদের অ্যাকাউন্ট বন্ধ করে দেওয়া হবে।" },
    { h: "২. গেমটি", p: "Zeus Thunder Slots একটি ৫-রিল, ২০-লাইনের স্লট গেম। প্রতিটি স্পিনের ফলাফল সার্ভার সিড, আপনার ক্লায়েন্ট সিড ও নন্স-এর প্রমাণযোগ্য-ন্যায্য হ্যাশ থেকে তৈরি হয়; খেলার আগে সার্ভার সিড হ্যাশ দেখানো হয় এবং ফেয়ারনেস প্যানেলে যেকোনো স্পিন পরে যাচাই করা যায়। স্ট্যান্ডার্ড কনফিগারেশনে ঘোষিত RTP ৯৬.০%।" },
    { h: "৩. ডিপোজিট ও উত্তোলন", p: "ওয়ালেটে দেখানো নির্দেশনা অনুযায়ী ডিপোজিট করা হয় (Binance PayID)। পর্যালোচনা ও নিশ্চিতকরণের পর ডিপোজিট জমা হয়। নিরাপত্তার জন্য উত্তোলন ম্যানুয়ালি পর্যালোচনা করা হয়; বড় অঙ্কের ক্ষেত্রে পরিচয় যাচাই চাওয়া হতে পারে। সর্বনিম্ন ও সর্বোচ্চ অঙ্ক ওয়ালেটে দেখানো থাকে।" },
    { h: "৪. ব্যালেন্স ও ত্রুটি", p: "আপনার ব্যালেন্স একটি নির্ভুল লেজারে রাখা হয়। প্রযুক্তিগত ত্রুটিতে ভুল অঙ্ক জমা বা কাটা হলে আমরা সংশ্লিষ্ট স্পিনের প্রকৃত ফলাফল অনুযায়ী লেজার সংশোধন করব এবং প্রভাবিত খেলোয়াড়দের জানাব। রক্ষণাবেক্ষণ মোডে করা বেট বাতিল ও ফেরত হতে পারে।" },
    { h: "৫. ন্যায্য খেলা", p: "বট, স্বয়ংক্রিয় খেলা, বাগের অপব্যবহার, যোগসাজশ এবং বোনাস বা রেফারেল সিস্টেমের অপব্যবহার নিষিদ্ধ। এসব কাজে জড়িত অ্যাকাউন্ট স্থগিত হতে পারে এবং এভাবে পাওয়া জয় বাতিল হতে পারে।" },
    { h: "৬. দায়িত্বশীল গেমিং", p: "সেটিংসে যেকোনো সময় দৈনিক ডিপোজিট ও ক্ষতির সীমা, সেশন সীমা এবং স্ব-বর্জনের সময়কাল সেট করতে পারবেন। স্ব-বর্জন আগে বাতিল করা যায় না। জুয়া হওয়া উচিত বিনোদন, অর্থ উপার্জন বা ক্ষতি পুষিয়ে নেওয়ার উপায় কখনোই নয়।" },
    { h: "৭. দায়বদ্ধতা", p: "গেমটি যেমন আছে তেমনভাবে দেওয়া হয়। আইন অনুমোদিত সর্বোচ্চ সীমা পর্যন্ত আমাদের দায়বদ্ধতা আপনার অ্যাকাউন্টের ব্যালেন্স পর্যন্ত সীমিত। এই শর্তাবলী প্রযোজ্য ভোক্তা আইনে আপনার অধিকার হ্রাস করে না।" },
    { h: "৮. পরিবর্তন", p: "আমরা এই শর্তাবলী আপডেট করতে পারি; গুরুত্বপূর্ণ পরিবর্তন গেমে ঘোষণা করা হবে। ঘোষণার পর খেলা চালিয়ে যাওয়া সম্মতি হিসেবে গণ্য হবে।" },
  ],
};

const PRIVACY: Record<"en" | "bn", Section[]> = {
  en: [
    { h: "What we collect", p: "Account details you give us (name, email or phone), your game and transaction history, device and connection information needed to operate and secure the service, and your responsible-gaming settings." },
    { h: "Why we use it", p: "To run your account and the game, process deposits and withdrawals, prevent fraud and abuse, enforce limits and self-exclusion, and meet legal obligations." },
    { h: "What we never do", p: "We do not sell your personal data. We do not share it with advertisers. Payment identifiers you provide are used only to process your own deposits and withdrawals." },
    { h: "Retention", p: "Transaction and game records are kept while your account is active and for a reasonable period afterwards for accounting, dispute and audit purposes, after which they are deleted or anonymised." },
    { h: "Your rights", p: "You may request a copy of your data or ask us to correct or delete it (subject to records we must keep by law) by contacting support through the channels shown in the game." },
    { h: "Security", p: "Passwords are stored as scrypt hashes, sessions use signed httpOnly cookies, and administrative access is restricted and audit-logged." },
  ],
  bn: [
    { h: "আমরা যা সংগ্রহ করি", p: "আপনার দেওয়া অ্যাকাউন্ট তথ্য (নাম, ইমেল বা ফোন), আপনার গেম ও লেনদেনের ইতিহাস, সেবা পরিচালনা ও নিরাপত্তার জন্য প্রয়োজনীয় ডিভাইস ও সংযোগ তথ্য, এবং আপনার দায়িত্বশীল-গেমিং সেটিংস।" },
    { h: "কেন ব্যবহার করি", p: "আপনার অ্যাকাউন্ট ও গেম পরিচালনা, ডিপোজিট ও উত্তোলন প্রক্রিয়া, জালিয়াতি ও অপব্যবহার প্রতিরোধ, সীমা ও স্ব-বর্জন কার্যকর করা এবং আইনি বাধ্যবাধকতা পূরণের জন্য।" },
    { h: "আমরা যা কখনো করি না", p: "আমরা আপনার ব্যক্তিগত তথ্য বিক্রি করি না। বিজ্ঞাপনদাতাদের সঙ্গে শেয়ার করি না। আপনার দেওয়া পেমেন্ট শনাক্তকারী শুধু আপনার নিজের ডিপোজিট ও উত্তোলনের জন্যই ব্যবহৃত হয়।" },
    { h: "সংরক্ষণ", p: "আপনার অ্যাকাউন্ট সক্রিয় থাকাকালীন এবং হিসাব, বিরোধ ও অডিটের জন্য তারপর যুক্তিসঙ্গত সময় পর্যন্ত লেনদেন ও গেম রেকর্ড রাখা হয়; এরপর সেগুলো মুছে ফেলা বা বেনামি করা হয়।" },
    { h: "আপনার অধিকার", p: "গেমে দেখানো মাধ্যমে সাপোর্টে যোগাযোগ করে আপনি আপনার তথ্যের অনুলিপি চাইতে, সংশোধন বা মুছে ফেলার অনুরোধ করতে পারেন (আইনত রাখতে বাধ্য রেকর্ড ব্যতীত)।" },
    { h: "নিরাপত্তা", p: "পাসওয়ার্ড scrypt হ্যাশ হিসেবে সংরক্ষিত হয়, সেশনে স্বাক্ষরিত httpOnly কুকি ব্যবহৃত হয়, এবং অ্যাডমিন অ্যাক্সেস সীমাবদ্ধ ও অডিট-লগভুক্ত।" },
  ],
};

const RG: Record<"en" | "bn", Section[]> = {
  en: [
    { h: "Play for fun, not for income", p: "Zeus Thunder Slots is entertainment with a built-in house edge (RTP 96.0% means that, on average over very many spins, 4% of stakes are retained). Never play with money you cannot afford to lose, and never chase losses." },
    { h: "Set your limits", p: "In Settings → Responsible Gaming you can set a daily deposit limit, a daily loss limit and a session time limit. Limits are enforced by the server on every deposit and spin, counted on the Dhaka calendar day, and apply across currencies (converted to USDT)." },
    { h: "Take a break — self-exclusion", p: "You can self-exclude for 7, 30 or 180 days from the same Settings section. During exclusion you cannot deposit or play. Self-exclusion starts immediately and cannot be cancelled or shortened early — that is deliberate, so the protection holds in a moment of weakness." },
    { h: "Warning signs", p: "Playing longer than planned, hiding play from family, borrowing to play, or feeling anxious when not playing are signs to stop and use the tools on this page." },
    { h: "Underage play", p: "Accounts are 18+. If a child can access your device, keep your session logged out and your credentials private." },
  ],
  bn: [
    { h: "মজার জন্য খেলুন, আয়ের জন্য নয়", p: "Zeus Thunder Slots একটি বিনোদন, যার মধ্যে হাউস এজ অন্তর্নির্মিত (RTP ৯৬.০% মানে, অনেক স্পিনের গড়ে বাজির ৪% থেকে যায়)। হারানোর সামর্থ্য নেই এমন অর্থ দিয়ে কখনো খেলবেন না, এবং ক্ষতির পেছনে ছুটবেন না।" },
    { h: "আপনার সীমা সেট করুন", p: "সেটিংস → দায়িত্বশীল গেমিং-এ আপনি দৈনিক ডিপোজিট সীমা, দৈনিক ক্ষতির সীমা এবং সেশন সময়ের সীমা সেট করতে পারেন। প্রতিটি ডিপোজিট ও স্পিনে সার্ভার এই সীমা কার্যকর করে, ঢাকার ক্যালেন্ডার দিন অনুযায়ী গণনা হয়, এবং সব মুদ্রায় প্রযোজ্য (USDT-তে রূপান্তরিত)।" },
    { h: "বিরতি নিন — স্ব-বর্জন", p: "একই সেটিংস অংশ থেকে ৭, ৩০ বা ১৮০ দিনের জন্য স্ব-বর্জন করতে পারেন। বর্জন চলাকালে ডিপোজিট বা খেলা যাবে না। স্ব-বর্জন সঙ্গে সঙ্গে শুরু হয় এবং আগে বাতিল বা কমানো যায় না — এটি ইচ্ছাকৃত, যাতে দুর্বল মুহূর্তেও সুরক্ষা বহাল থাকে।" },
    { h: "সতর্কতার লক্ষণ", p: "পরিকল্পনার চেয়ে বেশি সময় খেলা, পরিবারের কাছ থেকে খেলা লুকানো, খেলার জন্য ধার করা, বা না খেললে অস্থির লাগা — এগুলো থামার এবং এই পৃষ্ঠার টুলগুলো ব্যবহারের লক্ষণ।" },
    { h: "অপ্রাপ্তবয়স্কদের খেলা", p: "অ্যাকাউন্ট শুধুমাত্র ১৮+ দের জন্য। আপনার ডিভাইসে শিশুদের অ্যাক্সেস থাকলে সেশন লগ আউট রাখুন এবং লগইন তথ্য গোপন রাখুন।" },
  ],
};

export function TermsPage() {
  const { lang, t } = useLang();
  return <LegalShell title={t("termsTitle")} sections={TERMS[lang]} />;
}

export function PrivacyPage() {
  const { lang, t } = useLang();
  return <LegalShell title={t("privacyTitle")} sections={PRIVACY[lang]} />;
}

export function ResponsibleGamingPage() {
  const { lang, t } = useLang();
  return <LegalShell title={t("rgTitle")} sections={RG[lang]} />;
}
