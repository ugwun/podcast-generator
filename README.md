# podcast-generator

Lokalna webova aplikacia, ktora z tvojich dokumentov alebo temy vytvori podcast do 15 minut medzi dvoma moderatormi. Skript pise agent v T3 Code, hlasy generuje ElevenLabs.

## Spustenie

Potrebne su Node 24+ a beziaci T3 Code na tom istom stroji.

```bash
./start.sh
```

Aplikacia bezi na <http://localhost:5180> a je dostupna len z tohto pocitaca (pri WSL aj z Windows).

ElevenLabs kluc patri do `~/.config/podcast-generator/elevenlabs.env` s pravami `0600`, pripadne do premennej prostredia `ELEVENLABS_API_KEY`:

```bash
ELEVENLABS_API_KEY=...
```

Kluc potrebuje prava Text to Speech a Voices (Read). User (Read) je volitelne, bez neho aplikacia neukaze zostatok.

## Ako to funguje

1. **Zdroje.** PDF, Markdown, TXT a DOCX sa zmenia na text. Skenovane PDF bez textovej vrstvy aplikacia odmietne, OCR nepodporuje.
2. **Skript.** Server spusti `t3 thread start` v projekte `writer-workspace` a pocka na odpoved. Dlhe zdroje najprv skrati v samostatnych vlaknach, aby sa zmestili do limitu T3 (120 000 znakov). Skript sa da upravit rucne alebo poslat agentovi s pokynom.
3. **Audio.** Skript sa rozdeli na segmenty do 1900 znakov a kazdy prejde cez ElevenLabs Text to Dialogue (`eleven_v4`). Segmenty sa spoja, normalizuju priblizne na -16 LUFS a ulozia ako MP3; skutocnu hodnotu ukazuje prehravac.

Data su v `data/`, kazda epizoda ma vlastny priecinok a kazdy pokus o platene generovanie je v `data/ledger.jsonl`.

## Preco T3 CLI a nie MCP

MCP endpoint T3 vyzaduje OAuth s parovacim kodom a token plati 30 dni bez obnovy. Rezim `approval-required`, kvoli ktoremu by sa to oplatilo, prikaz v skusobnom behu nezastavil. Lokalny prikaz `t3 thread` funguje bez prihlasovania a cesta k nemu sa zistuje z beziaceho servera, takze prezije aj aktualizaciu T3.

## Bezpecnost dokumentov

T3 pusta agentov s plnym pristupom a nahrany dokument moze obsahovat skryte instrukcie. Preto vsetky behy idu do `writer-workspace`, kde `.claude/settings.json` zakazuje vsetky nastroje a `PreToolUse` hook odmietne kazde volanie. Dokumenty sa posielaju priamo v prompte, agent ziadny subor citat nepotrebuje. Plati to len pre Claude, preto aplikacia ine modely neponuka. **Tento subor nemen bez dovodu.**

Zlomyselny dokument teda nemoze spustit prikaz ani nic odoslat, stale vsak moze ovplyvnit text skriptu. Pred generovanim audia si skript precitaj.

## Ochrana kreditov

- Audio sa spusti az po potvrdeni poctu znakov.
- Pred kazdou poziadavkou sa zapise jej stav. Ak spojenie padne alebo server spadne, segment ostane *neisty* a nikdy sa neopakuje automaticky. Treba ho overit v historii ElevenLabs a povolit v aplikacii.
- Pocet znakov je horny odhad: realne generovanie v `eleven_v4` stalo asi 0,44 kreditu na znak a appka zapisuje skutocnu cenu z odpovede ElevenLabs.
- Hotove segmenty sa pouziju znova. Uprava jednej repliky pregeneruje len jej segment.
- Generovanie sa zastavi, ak merania ukazu, ze podcast by presiahol 15 minut. Maly presah do 5 % sa doladi tempom.

## Vyvoj

```bash
npm run dev        # server a Vite
npm test           # testy, nevolaju ElevenLabs ani T3
npm run typecheck
```

Premenne prostredia: `PORT`, `PODCAST_DATA_DIR`, `ELEVENLABS_MODEL`, `ELEVENLABS_KEY_FILE`, `T3_BIN`, `T3_RUN_TIMEOUT_MS`.
