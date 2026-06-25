# Operátori kézikönyv

Ez a kézikönyv az orchestrator mindennapi üzemeltetéséről szól: a dashboard, a flottával való kommunikáció, a tábla, az ütemezett feladatok, a titkok, a skillek és a biztonsági modell — mindez az operátor székéből nézve. A telepítést és az előfeltételeket külön dokumentum tárgyalja (`scripts/install.sh`); itt abból indulunk ki, hogy a rendszer telepítve van, és az `npm start` paranccsal indul.

A CITADEL (termék) és a NEXUS, FORGE, SPARK, SIGMA, RELAY, ORACLE, CREATIVE (csapat) nevek a seed konfigurációból jönnek (`seed/seed.config.json`). Ezek konfiguráció, nem kód — a te telepítésed más márkanévvel és más csapattal is futhat. A kézikönyv a konkrétság kedvéért a seed neveit használja.

## 1. Első találkozás: a dashboard megnyitása

Indítsd el a supervisort:

```bash
npm start
```

Az **első** induláskor (amikor a hozzáférési token frissen jön létre) a bootstrap URL a **stderr-re** íródik ki — logfájlba soha:

```
CITADEL dashboard: http://127.0.0.1:7080/?token=<hosszú-véletlen-token>
```

Minden későbbi indulás már csak a dashboard URL-t írja ki, mellette az állapotkönyvtárban lévő 0600-as `dashboard-token` fájlra mutató utalással, így a token soha többé nem jelenik meg semmilyen kimenetben. A bootstrap URL-t eszközönként (böngészőnként) egyszer kell megnyitni. Az egyoldalas alkalmazás kiolvassa a `?token=` paramétert, elmenti a böngésző localStorage-ába, és azonnal eltünteti a címsorból. Onnantól az a böngésző hitelesítve van; a tokenes URL-re azon az eszközön többé nincs szükség. A token root-jogú — a bootstrap URL-t kezeld jelszóként. Ha később új eszközt kötsz be, olvasd ki a tokent a fájlból, és nyisd meg egyszer a `http://127.0.0.1:7080/?token=<érték>` címet.

A dashboard telepíthető PWA (manifest + service worker). A service worker az `/api/*` válaszokat soha nem gyorsítótárazza, így amit látsz, az mindig élő adat. A szerver alapból loopbackre köt (`127.0.0.1:7080`); a gépen kívülre tenni tudatos konfigurációs döntés.

A bal oldali navigáció nézetei:

- **Flotta** (kezdőlap): ügynökönként egy kártya a szereppel, az élő és a kívánt állapottal, valamint Indítás/Leállítás/Újraindítás/Megfigyelés gombokkal; alul lenyitható "új ügynök" űrlap. A fejlécben a Jóváhagyások felé mutató link jelenik meg, ha van függő tétel.
- **Ügynök** (a navigációban rejtett; a Flotta → Megfigyelés gombbal nyílik, útvonala `#agent/<id>`): az élő figyelés + gépelés nézet — lásd a 3. fejezetet.
- **Tábla**: a kanban tábla — lásd a 4. fejezetet.
- **Ötletek**: az ötletláda és az autonómia-létra panel — lásd a 4. és 5. fejezetet.
- **Memória**: ügynökönkénti memória-böngésző réteg-fülekkel (forró/meleg/hideg/megosztott), kereséssel, mentéssel és helyben szerkesztéssel. A "törlés" itt mindig puha archiválás — memória soha nem törlődik véglegesen.
- **Ütemezés**: ütemezett feladatok, az újrapróbálkozási sor és a legutóbbi futások — lásd a 6. fejezetet.
- **Készségek**: a kétszintű skill-böngésző — lásd a 8. fejezetet.
- **Széf**: titkok és kötések — lásd a 7. fejezetet.
- **Csatornák**: a Telegram csatorna állapota és beállítása — lásd a 2. és 7. fejezetet.
- **Jóváhagyások**: a függő spawn-kérelmek sora és a még jóváhagyásra váró kanban-kártyák. A navigációs bejegyzésen számláló jelzi, ha van várakozó tétel.
- **Beállítások**: a felület nyelve és témája (eszközönként), valamint a szerverbeállítások — lásd a 9. fejezetet.

A navigáció alján találod a nyelv- és témaváltót; mindkettő azonnal, újratöltés nélkül érvényesül, és eszközönként megjegyzésre kerül.

## 2. Beszélgetés a hubbal

A hub (a seed csapatban NEXUS) az egyetlen kapcsolattartód a flotta felé. Két úton éred el:

**Telegramon** — ha a csatorna be van állítva (7. fejezet) és a supervisor újraindult, az operátori chatből érkező üzeneteket a szerver operátorként bélyegzi és a hubhoz irányítja. Minden más chat alapból tiltott: az ismeretlen chatekből jövő üzenetek válasz nélkül eldobódnak. A hub ugyanabban a chatben válaszol.

**A dashboardon** — nyisd meg a hub ügynök-nézetét (Flotta → NEXUS → Megfigyelés), és gépelj közvetlenül az élő munkamenetébe. Ez a hubbal pontosan úgy működik, mint bármelyik ügynökkel (3. fejezet).

**Így működik a delegálás.** A hub nem végez maga szakmunkát. Amikor érdemi munka érkezik, felbontja, és kanban-kártyákat hoz létre a megfelelő specialistáknak. A dispatch-szabály mechanikus, és érdemes ismerni:

- Egy kártya **in_progress**-be mozgatása **pontosan egyszer** küldi ki a feladatot a felelősnek. A kiküldés kizárólag a mozgatás műveletből indul, és a `dispatched_at` bélyeg őrzi — ha a kártyát kiveszed az in_progress-ből, majd visszateszed, nem küldődik ki újra.
- A felelős ügynök gépi injektálással kapja meg a kártya számát, prioritását, címét és leírását, és a végén az `agentctl`-lel maga lépteti tovább a kártyát.
- A kiküldés szándékosan nem csinál semmit, ha a felelős te vagy (operátor), üres, ismeretlen, vagy **nem fut**. Utóbbi esetben a kártya egyszerűen in_progress-ben marad; indítsd el az ügynököt (Flotta), és kérd meg a hubot az újraküldésre, vagy írj kommentet a kártyára.

Ugyanezt a mechanizmust kézzel is meghajthatod: hozz létre kártyát a Táblán, jelölj ki felelőst, és mozgasd in_progress-be — a kijelölt ügynök a kártyával ébred.

## 3. Bármelyik élő ügynök figyelése és a közvetlen gépelés

Az ügynök-nézet (`#agent/<id>`) az elsődleges emberi ablak bármelyik futó ügynökre — függetlenül attól, hogy éppen ki vagy mi vezérli.

- **Élő kimeneti folyam**: server-sent event stream az ügynök termináljáról. Minden frissítés az ügynök képernyőjének teljes, *megjelenített pillanatképe*, amely lecseréli a nézetet — valódi "figyeld ezt a terminált" vetítés, nem nyers bájtfolyam (a terminál nyers folyama tele van kurzorpozícionáló escape-ekkel, és soronként hozzáfűzve olvashatatlan volna). Ha a kapcsolat megszakad, a böngésző magától újracsatlakozik, a nézet pedig jelzi az újracsatlakozást — újratölteni soha nem kell. A nézet ügynökönként az utolsó 500 sort tartja meg, és automatikusan görget, hacsak fel nem görgettél.
- **Küldés**: írj a beviteli sorba, és nyomd meg a Küldés gombot. A szöveged a supervisor ügynökönkénti, egyszálú sorosítóján megy át — a gépi kézbesítés és a te gépelésed soha nem keveredhet össze üzenet közben. Ha az ügynök dolgozik, a beviteled megvárja, míg készen áll.
- **Megszakítás**: a Megszakítás gomb *erőltetett* injektálás: előbb megszakítja az ügynök folyamatban lévő körét, majd egy szabványos "operátori megszakítás, állj le és várj" promptot kézbesít. Elszabadult vagy beragadt ügynök leállítására való.
- **Naplózás**: minden, amit itt begépelsz, *még a kézbesítés előtt* bekerül a beszélgetési főkönyvbe (conversation ledger), operátorként megjelölve. Naplózatlan operátori bevitel nem létezik.

A fejlécben (és a Flotta-kártyákon) látható állapotok jelentése:

| Állapot | Jelentés |
|---|---|
| **Leállítva** | Nincs futó munkamenet. |
| **Készen áll** | Tétlen, azonnal fogad bevitelt. |
| **Dolgozik** (busy) | Kör közben van; a nem erőltetett bevitel várakozik, az erőltetett megszakít. |
| **Bemenetre vár** | A munkamenet egy kérdésnél áll (pl. engedélykérés). Ha begépelsz, azzal válaszolsz rá. |
| **Újbóli bejelentkezés szükséges** | A munkamenet hitelesítése lejárt. Ebben az állapotban az ügynök **semmilyen** bevitelt nem kap — lásd a 10. fejezetet. |

A folyam alatti panel az ügynök beszélgetési szálait listázza (partnerenként az utolsó üzenettel), így látod, kivel levelezett.

## 4. A tábla és az ötletláda

### A tábla

A kártyáknak négy státusza van — **planned → in_progress → waiting → done** —, ezek a tábla négy sávja. A planned a belépő oszlop; külön backlog nincs. A prioritások: **low / normal / high / urgent** (a high és az urgent vizuálisan is jelölt). A kártya kaphat szabad szöveges **projekt** címkét; a tábla tetején lévő szűrővel egy projektre szűkíthetsz.

Kattints egy kártyára a részletpanelhez:

- A **Mozgatás** gombok váltják a státuszt. Az in_progress-be mozgatás a dispatch-trigger (2. fejezet).
- A **kommentek** csak hozzáfűzhetők és név szerint jelöltek (te `operator`-ként jelensz meg, az ügynökök a saját azonosítójukkal).
- A **Jóváhagyás** gomb a `jóváhagyás szükséges` jelölésű kártyákon jelenik meg, és feloldja a kaput (egyúttal "approved" kommentet naplóz). Ezek a kártyák a Jóváhagyások nézeten is összegyűlnek.
- Az **Archiválás** puha archiválás — a kártya eltűnik a tábláról, de a történet megmarad.
- A **Törlés** megerősítéshez kötött végleges törlés, és csak neked elérhető; a kommenteket is viszi.
- A **Felbontás** részfeladatokra bontja a kártyát: soronként egy cím. Minden részfeladatot egy kulcsszavas útválasztó sorol be a megfelelő specialista-sávba (a sávok és kulcsszavak konfiguráció — a config `lanes` blokkja), így a "javítsd a build scriptet" a FORGE-hoz, a "kutasd fel a piacot" az ORACLE-höz kerül. A felbontás egyszintű: egy részfeladat már nem kínálja fel az űrlapot.

A lap alján lévő űrlappal hozhatsz létre új kártyát (cím, leírás, felelős, prioritás, projekt).

### Az ötletláda

Az ötlet könnyebb műfaj, mint a kártya: olyasmi, amit te vagy a flotta észrevett, de még nem munka. Státuszok: **new, reviewed, kanban, rejected, archived** — a felső fülek státusz szerint szűrnek, az Archivált kapcsoló a archiváltakat mutatja.

Ötletenként:

- A **Táblára** (promote) gomb létrehoz egy hozzákapcsolt kanban-kártyát, és az ötletet `kanban` státuszba teszi. A kapcsolat kétirányú — az ötlet sorában látszik a kártya száma.
- A **Felbontás** előlépteti az ötletet *és* az új kártyát azonnal sáv-irányított részfeladatokra bontja (soronként egy).
- Az **Elutasítás** és az **Archiválás** puha státuszváltás; semmi nem törlődik soha.
- **Automatikus archiválás**: amikor egy előléptetett ötlet kapcsolt kártyája `done`-ba ér, az ötlet magától archiválódik.
- Az **Egyeztetés** (reconcile) gomb ugyanennek a szabálynak a kézi söprése: archivál minden olyan ötletet, amelynek a kapcsolt kártyája már kész, és jelzi, hányat talált. Akkor használd, ha egy automatikus archiválás kimaradt (a mozgatási hookok szándékosan hibatűrők — egy hook hibája soha nem akadályozza meg a kártya mozgatását).

A hozzáadó űrlap (cím, leírás, kategória) a lista alatt van; az ügynökök ugyanígy adnak hozzá ötletet az `agentctl idea add` paranccsal.

## 5. Az autonómia-létra

Az Ötletek nézet alján ül az autonómia-létra: kategóriánkénti bizalmi szintek, amelyek azt szabályozzák, meddig cselekedhetnek az ügynökök nélküled.

- Minden kategóriának van **szintje (1–3)**, **maximális szintje**, és lehet rajta **zárolt** jelvény. Az 1-es szint azt jelenti, hogy a kategória valódi emberi döntés — az ügynöknek cselekvés előtt hozzád kell fordulnia. A magasabb szintek fokozatosan több szabadságot adnak: cselekedni és beszámolni, nem kérdezgetni.
- Öt kategória **kódban van keményen zárolva**, és soha nem léphet az 1-es szint fölé — bármit próbál a felület, a konfiguráció vagy egy ügynök: **publish, payment, data-delete, permission-change, external-message**. A szerver minden módosítást visszautasít (403-as hibaüzenetet kapsz toastban), és induláskor még egy manipulált adatbázis-sort is visszajavít 1/1/zárolt értékre.
- A seed hét állítható kategóriát hoz — `kanban_archive_done`, `kanban_stuck_nudge`, `memory_maintenance`, `routine_trivial_fix`, `deploy_retry`, `kanban_restructure`, `skill_patch` — 1-es szinten, 3-as maximummal, plusz az `email_send`-et (1-es szint, 2-es maximumra korlátozva). A módosításaid túlélnek minden újraindítást és frissítést; az újra-seedelés soha nem írja vissza az operátor által beállított szintet.

## 6. Ütemezett feladatok és a tanulási kör

Az Ütemezések nézet kezeli az időzített promptokat.

**Ütemezési formátum**: szabványos 5 mezős cron — `perc óra hónap-napja hónap hét-napja`, pl. `30 7 * * 1-5` hétköznap 07:30-ra. Az `@hourly`, `@daily`, `@weekly`, `@monthly` aliasok is elfogadottak. Az ütemezések a szerver beállított **időzónájában** értékelődnek ki (Beállítások; a seed alapértelmezése Europe/Budapest). Az ütemezőnek felzárkózási ablaka van, így egy rövid kiesés vagy újraindítás alatt elmulasztott tüzelés késve, de kézbesítésre kerül (az indulás utáni első körben hosszabb ablak érvényes).

**Mezők**: minden feladatnak van azonosítója, címe, promptja (az ügynöknek kézbesített szöveg), cron-kifejezése, célja (egy ügynök vagy `all`) és típusa — **task** (normál kézbesítés) vagy **heartbeat** (csendes konszolidációs ütem).

**Kapcsolók**:

- **skipIfBusy** — ha a cél éppen dolgozik, ez a tüzelés csendben kimarad. Opcionális, és csak sűrű ütemű feladatoknál van értelme, ahol a következő tüzelés úgyis közel van (a seedelt 30 perces heartbeat használja).
- **forceSend** — kézbesítés dolgozó ügynökbe is: előbb megszakítja a folyamatban lévő kört, aztán injektál. A "most azonnal futnia kell" feladatok vészkijárata (a reggeli brief használja).
- **bypassTriage** — a feladat minden triage-t megkerülve, feltétel nélkül lefut: a futtató pontosan úgy kezeli, mint a forceSendet (dolgozó ügynökbe is kézbesít, a folyamatban lévő kört megszakítva). Olyan heartbeat-jellegű feladatokhoz való, amelyeknek csendes vagy elfoglalt napokon is tüzelniük kell.

**A soha-fel-nem-adó újrapróbálkozási sor.** A skipIfBusy nélküli feladat, amelynek célja foglalt vagy nem fut, *nem* veszik el: bekerül az újrapróbálkozási sorba, és addig próbálkozik újra (a seed szerint 10 percenként), amíg kézbesül vagy te le nem mondod. A sor ezen a nézeten látható, soronkénti Megszakít gombbal. Ha egy besorolt feladat tartósan elakad, pontosan egy riasztást kapsz az operátori csatornán (a riasztási jelző még a küldés előtt foglalódik le, így párhuzamos körök és újraindítások sem tudnak duplán riasztani). A "Legutóbbi futások" panel minden tüzelés kimenetelét mutatja: kézbesítve, sorba állítva, kihagyva vagy sikertelen.

**A seedelt tanulási kör.** Öt feladat érkezik a rendszerrel:

| Azonosító | Ütemezés | Cél | Mit csinál |
|---|---|---|---|
| `heartbeat-consolidate` | `*/30 * * * *` | mindenki | Csendes konszolidáció: memória mentése, napi naplósor, megfontolja, kell-e újrahasznosítható skill. Téged soha nem keres. skipIfBusy. |
| `nightly-dream` | `30 2 * * *` | hub | Felülírja az éjszakai dream-fájlt: csapat-összefoglaló, javaslatok, memória-egészség, holnapi top-3; hétfőnként lehetőség-szkennelés is. Csak fájl/memória kimenet. |
| `dream-consumer` | `0 7 * * *` | hub | A dream-javaslatokat cselekvéssé alakítja: lokális skillek, kanban-kártyák, ötletláda-tételek. Téged soha nem keres. |
| `cross-agent-sync` | `15 3 * * *` | hub | Megosztott rétegű memóriát ír arról, ki mit csinált és ki miben jó. |
| `morning-brief` | `0 8 * * *` | hub | Az egyetlen ütemezett feladat, amely elérheti a csatornádat: tegnapi összefoglaló, tábla-állapot, friss ötletek, mai top-3. forceSend. |

Az alvásod alatt futó háttérfeladatok soha nem üzenhetnek élő csatornára — szándékosan egyedül a reggeli brief teszi, és az is csak a hubon keresztül.

**A kör hangolása**: bármelyik seedelt feladat helyben szerkeszthető (prompt, cron, kapcsolók) vagy kikapcsolható — a módosításaidat az újra-seedelés soha nem írja felül. Elnémításhoz **ne** töröld a seedelt feladatot: a seedelés "beszúrás, ha hiányzik" elven működik, így a törölt seed-feladat a következő indulásnál (seed-alapértékekkel) újra megjelenik. Inkább kapcsold ki.

## 7. A széf

A Széf nézet az egyetlen hely, ahol a titkok értéke nyílt szövegként létezik — az is csak rövid időre.

- **A lista csak metaadatot mutat** — azonosító, címke, időbélyegek. Értéket az API sehol nem ad listában.
- A **Felfedés** egyetlen értéket kér le kifejezetten; 30 másodpercig látszik, aztán magától elrejtődik. A Másolás vágólapra teszi. Felfedési fegyelem: csak azt fedd fel, amit éppen használni készülsz, és titok értékét soha ne illeszd be chatbe, kártyára, memóriába vagy bármibe, amit egy ügynök elolvas.
- **Beállítás / frissítés**: az űrlap (azonosító, címke, érték) létrehoz vagy felülír egy titkot. Az érték mezője mentés után azonnal kiürül; egy frissített titok a képernyőn még felfedve maradt régi értéket is érvényteleníti.
- A **Törlés** megerősítés után eltávolítja a titkot.
- A titkok titkosítva tárolódnak (AES-256-GCM, titkonként származtatott kulcs) az SQLite adatbázisban; a mesterkulcs külön 0600-as fájlban él az állapotkönyvtárban. A konfigurációs fájlokban mindig csak `vault:<id>` hivatkozás áll, nyílt érték soha.
- A **kötések** (bindings) egy titok-azonosítót rendelnek egy környezeti változó nevéhez (opcionálisan célonként). A panel ezeket a hozzárendeléseket rögzíti és kezeli. **Elhalasztva:** a jelenlegi buildben a kötéslista csak nyilvántartás — az indítási útvonal még nem injektálja a kötött titkokat az ügynökök környezetébe. A széf egyetlen élő automatikus fogyasztója a lenti Telegram token.

**A Telegram token útja.** A Csatornák nézeten illeszd be a bot tokent az űrlapba. A token írás-csak: egyenesen a széfbe kerül `telegram-bot-token` azonosítóval, a konfigurációs fájlban csak a `vault:telegram-bot-token` hivatkozás marad, és az űrlapmező soha nem mutatja vissza. Állítsd be az **operátori chat azonosítót** (a saját Telegram-chated a bottal), és pipáld be az **engedélyezve** mezőt. A változás a supervisor következő újraindításakor lép életbe — a nézet ezt külön jelzi. Újraindítás után az állapotkártyán látszik az engedélyezve / kapcsolódva / token beállítva állapot, a Teszt gomb pedig a Telegram API felé ellenőrzi a tokent. Kizárólag az operátori chat hordozza a te felhatalmazásodat; minden más chat alapból tiltott.

## 8. Készségek (skillek)

A skill újrahasznosítható instrukció, amelyet az ügynökök igény szerint töltenek be. Két hatókör van:

- A **globális** skillek az egész flotta számára láthatók.
- Az **ügynök-szintű (lokális)** skillek csak a gazdájuknak. Egy ügynök indexe soha nem fedi fel másik ügynök lokális skilljeit.
- A globálissal azonos nevű lokális skill az adott ügynöknél **árnyékolja** (felülfedi) a globálisat — a böngésző "árnyékol" jelvénnyel jelöli ezeket, amikor egy ügynök effektív készletét nézed.

A nézet választójával a globális lista és egy-egy ügynök effektív készlete (globális + saját lokális) között váltasz. A névre kattintva nyílik az olvasó: a skill teljes törzse és a segédfájlok listája.

**Irányítás** (a szerver oldalon kikényszerítve; a szabályszegés 403-as toastként jön vissza):

- **Globális** skill létrehozásához hub-jóváhagyás kell. A dashboardon végzett műveleteid a hub fölött állnak, így a felületről létrehozott globális skill automatikusan jóváhagyottnak számít. Az ügynökök a saját **lokális** skilljeiket szabadon létrehozhatják; ha nem-hub ügynök próbál globális skillt írni, elutasítást kap.
- A **rögzített** (pinned, gyári) skillek megváltoztathatatlanok: a felület nem is kínál rájuk törlést, és a szerver egyébként is visszautasítaná.
- Skillt törölni csak operátorként lehet.

Az **importálás** a gazdagép egy könyvtárából hoz be skillt (az elérési út az űrlapban, a hatókör és a cél-ügynök választható). Az importáló elutasítja az útvonal-kitörést (path traversal) és a symlinkeket, és nem ír felül létező skill-nevet — egy rosszindulatú vagy hanyag skill-könyvtár nem tud se kitörni, se felülírni semmit.

## 9. Téma, nyelv és szerverbeállítások

A beállításoknak két, egymástól független rétege van:

**Eszközönként (ebben a böngészőben)** — a Beállítások nézeten (és a navigáció alján):

- **A felület nyelve**: a magyar és az angol teljes katalógussal érkezik. A váltás azonnali — se újratöltés, se szerver-újraindítás —, a választás a böngészőben tárolódik, és már az első kirajzolás előtt érvényesül (nincs rossz nyelvű villanás).
- **Téma**: az alapértelmezett sötét "arcane" és a világos "daylight". Ugyanígy: azonnali, eszközönként megjegyzett, kirajzolás előtt alkalmazott.

**Szerverbeállítások** (az egész telepítésre érvényesek):

- **Alapértelmezett felületi nyelv**: a telepítéskori választás (`./scripts/install.sh --locale hu|en`); ezt látja egy friss eszköz, mielőtt sajátot választana. A módosítása a backend operátornak szóló szövegeit is élőben átváltja.
- **Az ügynökök prózanyelve**: független tengely — az a nyelv, amelyen az ügynökök *neked* írnak. Futtathatsz angol felületet magyar ügynök-prózával vagy bármilyen más kombinációt; a kettő szándékosan nincs összekötve.
- **Időzóna**: IANA név (pl. `Europe/Budapest`); a cron-ütemezések ebben értékelődnek ki.
- **Terméknév**: élőben átmárkázza a dashboardot és az értesítéseket.

## 10. Ügynök-életciklus

Az **Indítás / Leállítás / Újraindítás** gombok a Flotta-kártyákon és az ügynök-nézet fejlécében vannak. Az újraindítás mellett **friss (kontextus elvetése)** jelölőnégyzet áll:

- a normál újraindítás **folytatja** az előző munkamenetet — az ügynök megtartja a felhalmozott kontextusát;
- a **friss** újraindítás eldobja a kontextust, és tisztán indul. Akkor használd, ha az ügynök összezavarodott vagy a kontextusa leromlott.

Bárhogy is indul újra, minden (újra)indított munkamenet közvetlenül az indulás után gépi injektálással **folytonossági visszajátszást** kap: a friss beszélgetési átiratot (a nyitott kérdés megjelölésével) és az ügynök utoljára mentett feladatállapotát — így az ügynök ott folytatja, ahol abbahagyta, nem üres fejjel ébred.

**Kívánt állapot és a reconciler.** Az indít/leállít gombok két dolgot tesznek: azonnal cselekszenek, és elmentik a *szándékodat* ("ennek az ügynöknek futnia kell"). Egy háttérfolyamat percenként összeveti a szándékot a valósággal, és kijavítja az eltérést — a futnia-kéne-de-nem-fut ügynökök újraindulnak (lépcsőzetesen, hogy egy kiesés után ne induljon mindenki egyszerre), a leállítva-kéne-de-fut ügynökök leállnak. Egy összeomlott ügynök tehát magától visszajön; az általad leállított leállítva marad. A flotta-kártyán a kívánt állapot az élő állapot mellett látszik.

**Az ügynökök túlélik a supervisor újraindítását.** Az ügynökök a flotta saját, dedikált tmux szerverén futnak (külön socketen, `citadel-mux`), és a sessionöket ez a szerver birtokolja, nem a supervisor. Így a supervisor újraindítása vagy újratelepítése (pl. `systemctl restart citadel`) **nem** állítja le az ügynököket — az új supervisor egyszerűen *adoptálja* a még futó sessionöket, és újracsatlakozik hozzájuk. Egyetlen beragadt ügynök helyreállítása csak az adott ügynök sessionjének újrapörgetése; a szervert (és az összes többi ügynököt) ez soha nem érinti. Az egész flotta szándékos leállításához állítsd le explicit módon a szervert: `tmux -L citadel-mux kill-server`.

**Ügynök létrehozása és törlése.** A Flotta űrlapja új ügynököt hoz létre (azonosító, név, szerep, biztonsági profil, kísérőszín). Választható profilok: sandbox, draft, trusted-build; a full-host profil kizárólag előre seedelt konfigurációként létezik, és soha nem osztható ki — sem új ügynöknek, sem meglévőnek (a seed-csapatot is beleértve) profilváltással. A seed-csapat ügynökei nem törölhetők — a nevük foglalt; a saját kezűleg létrehozottak (megerősítéssel) igen.

**Reauth-eszkaláció.** Az ügynökök interaktív Claude Code munkamenetekként futnak tmuxban, az előfizetéses bejelentkezésed terhére. Amikor egy munkamenet hitelesítése lejár, az ügynök **Újra be kell jelentkezni** állapotba kerül. Három dolog garantált:

1. Ebben az állapotban az ügynök semmilyen bevitelt nem kap — az injektálási kísérlet hibával elutasul, ahelyett hogy a halott munkamenetbe gépelődne.
2. Epizódonként pontosan egyszer kapsz értesítést az operátori csatornán.
3. **Hitelesítő adat soha nem injektálódik automatikusan.** A rendszer soha nem gépel be jelszót vagy tokent egy munkamenetbe. A bejelentkezést kézzel végzed:

```bash
tmux -L citadel-mux attach -t citadel-<ügynök-id>     # pl. tmux -L citadel-mux attach -t citadel-nexus
# végezd el a bejelentkezést a munkamenetben, majd válj le: Ctrl+B, aztán D
```

(A `citadel-mux` a seed dedikált tmux socketje, a `runtime.claude.socket`; a `citadel-` session-előtag a `runtime.claude.sessionPrefix` — ha bármelyiket átírtad, nézd meg a konfigurációban.) Amint a munkamenet hitelesít, az állapot magától tisztul.

## 11. A biztonsági modell operátori szemmel

Nem kell a kódot olvasnod ahhoz, hogy megbízz a rendszerben, de érdemes tudni, mi tartja össze:

**Bizalmi keretek.** Minden ügynöknek kézbesített üzenet biztonsági keretbe csomagolva érkezik, amely kimondja, valójában kitől jön: operátor, hub, megbízható társ, nem megbízható, vagy külső csatorna. Kizárólag az operátor-keret hordozza a te felhatalmazásodat. Az üzenet törzsében lévő keret-szerű címkéket a kézbesítés előtt egy véletlen, folyamatonkénti jelölővel semlegesíti a rendszer — egy feladó nem tud záró címkét hamisítani és hamis "operátor"-keretet nyitni, mert a jelölő kitalálhatatlan.

**Miért nem működik a feladó-hamisítás.** Amikor egy ügynök üzenetet ad fel, a szerver a magára vallott feladót felülírja az API-tokenjéhez kötött identitással. A foglalt identitásokat (operátor, a hub azonosítója, csatorna) a nem hitelesített feladóktól azonnal elutasítja, a te üzeneteid pedig külön, csak-operátor végponton mennek, amely a feladót a szerver oldalon bélyegzi. Ügynöknek vagy külső félnek egyszerűen nincs útja arra, hogy egy üzenet a te nevedben *érkezzen meg*.

**A spawn-jóváhagyási sor.** Az ügynökök (a gyakorlatban: csak a hub) programból kérhetnek új ügynököt. A jogosultsági kapu tiszta, kimerítően tesztelt kód:

- Programból csak a hub spawnolhat; minden más ügynök elutasítást kap.
- Gyermek soha nem lépheti túl a kérelmező jogosultságát (nincs ön-eszkaláció).
- A sandbox-szintű kérések automatikusan átmennek; minden, ami a sandbox fölött van, a Jóváhagyások sorba **parkol**, és a te kifejezett jóváhagyásodra/elutasításodra vár. Az operátori csatornán értesítést kapsz, ha valami parkol.
- A dashboardon végzett műveleted számít az emberi jóváhagyásnak — de csak a plafonig.

**A profil-plafon.** A jogosultsági szintek: 0 (sandbox), 1 (draft), 2 (trusted-build), 3 (full-host). A 2-es szint az abszolút spawn-plafon: fölötte soha semmi nem hozható létre — sem ügynök által, sem általad a dashboardon. A full-host kizárólag az előre seedelt csapaté (a hubé). Ugyanez a plafon érvényes a meglévő ügynökök profilváltásaira is.

Három további állandó garancia: a rendszer indulni (és települni) is megtagad, ha a számlázást átkapcsoló változók bármelyike — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` — jelen van a környezetben (és mind a négyet le is választja minden ügynök-indításról), mert egy ottfelejtett hitelesítő adat az előfizetéses munkameneteket csendben mért vagy külső számlázásra váltaná; a dashboard-token és a széf mesterkulcsa 0600-as fájlokként élnek az állapotkönyvtárban (alapból `~/.orchestrator`, illetve `$ORCHESTRATOR_STATE_DIR`); és minden, amit élő ügynökbe gépelsz, neked tulajdonítva ott van a beszélgetési főkönyvben.
