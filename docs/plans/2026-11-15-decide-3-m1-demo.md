# decide 3.0, milestone 1: try it yourself

Milestone 1 replaced the server underneath the page. The page looks almost the same as 2.1.1; what changed is that a round now lives on disk and one server serves every project. These five commands show that on your machine. They use a scratch home, so your real `~/.decide` and the decide you run day to day are not touched.

Run the setup line from a checkout of the `v3` branch (not the main checkout, which stays on 2.1.1). It makes a scratch home and a project folder, copies the demos there, and keeps the path to this checkout's `decide.mjs` in `$D`:

```bash
export DECIDE_HOME=$(mktemp -d)/dh D=$PWD/decide.mjs; mkdir -p /tmp/m1-demo && cp -R examples/v3/m1-recovery.questions.json examples/swipe.deck.json examples/swipe.assets /tmp/m1-demo/ && cd /tmp/m1-demo && git init -q
```

## 1. Open the recovery demo

```bash
node $D ask m1-recovery.questions.json --live
```

The page opens. Answer the first two questions, then press "Ask the agent" on the third and type anything. The command prints your question and exits: that is the agent's cue to answer.

## 2. Kill the server

```bash
kill -9 $(node -e 'console.log(require(process.env.DECIDE_HOME + "/daemon.json").pid)')
```

This is a hard kill: the server gets no chance to save anything on the way out.

## 3. Bring it back

```bash
node $D open
```

This starts a new server on the same port. Reload the page: both answers and your question are still there, and the header says the agent stepped away.

## 4. Answer as the agent

```bash
node $D --reply <round> --question checks --text "kill -9 is enough: every answer is a line in the round's log."
```

Take `<round>` from the page address (`#r=…`) or from the output of the first command. The reply shows up under your question without a reload. Finish the round with Done, then run `node $D --wait <round> --live` to collect the answers into `m1-recovery.answers.json`.

## 5. Three cold calls, one server

```bash
node $D stop; for i in 1 2 3; do node $D ask m1-recovery.questions.json --no-open --out c$i.answers.json & done; sleep 5; ps -ax | grep '[d]ecide.mjs serve'
```

Three rounds start at the same moment with no server running. The last line lists exactly one `decide.mjs serve`. Stop the three waiting calls with Ctrl+C, then `node $D stop`.

The swipe deck behaves the same way: `node $D swipe swipe.deck.json --live`, answer a few cards with the arrow keys, then repeat steps 2 and 3.
