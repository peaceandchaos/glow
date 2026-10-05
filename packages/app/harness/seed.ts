import type { ChatArchive } from '../src/state/archive';

type SeedTurn = { question: string; answer: string };

// Saves finished turns the way a settled reply ends up on disk: completed,
// acknowledged, and off the job list, so the session has nothing to resume.
export function seedChat(archive: ChatArchive, turns: SeedTurn[]): string {
  const chat = archive.createChat();
  for (const turn of turns) {
    const reply = archive.createTurn(chat.id, turn.question, []);
    archive.saveMessages([
      { ...reply, status: 'completed', accepted: true, text: turn.answer },
    ]);
    archive.acknowledge(reply.id);
  }
  return chat.id;
}

export function longTurns(count: number): SeedTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    question: `Question ${index + 1}`,
    answer: `Answer ${index + 1}. ${'This line pads the reply. '.repeat(1 + (index % 4))}`,
  }));
}
