export type TranscriptTurn = {
  id: string;
  userBlockId: string | null;
  processIds: string[];
  answerIds: string[];
};

export function groupTranscriptTurns(
  blockIds: readonly string[],
  read: (id: string) => { body: { kind: string } } | undefined | null,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const id of blockIds) {
    const kind = read(id)?.body.kind;
    if (kind === "userText") {
      turns.push({ id, userBlockId: id, processIds: [], answerIds: [] });
      continue;
    }
    if (!turns.length) turns.push({ id: "continued", userBlockId: null, processIds: [], answerIds: [] });
    const turn = turns[turns.length - 1];
    (kind === "assistantText" ? turn.answerIds : turn.processIds).push(id);
  }
  return turns;
}

export function shouldLoadEarlier(scrollTop: number, hasOlder: boolean, loading: boolean) {
  return scrollTop <= 180 && hasOlder && !loading;
}
