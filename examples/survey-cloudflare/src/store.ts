export type Answer = { q1: 'great' | 'ok' | 'poor'; q2: 'office' | 'hybrid' | 'remote'; q3: 'pay' | 'growth' | 'culture' };
export type SavedAnswer = Answer & { subject: string; submittedAt: string };
export type ExportState = { status: 'none' } | { status: 'ready'; value: { id: string; bytes: number; createdAt: string } };
const endpoint = 'http://pneuma-space-survey.internal/';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const savedAnswer = (value: unknown): value is SavedAnswer => record(value)
  && typeof value.subject === 'string' && typeof value.submittedAt === 'string'
  && ['great', 'ok', 'poor'].includes(String(value.q1))
  && ['office', 'hybrid', 'remote'].includes(String(value.q2))
  && ['pay', 'growth', 'culture'].includes(String(value.q3));
const exportState = (value: unknown): value is ExportState => record(value)
  && (value.status === 'none' || value.status === 'ready' && record(value.value)
    && typeof value.value.id === 'string' && typeof value.value.bytes === 'number'
    && typeof value.value.createdAt === 'string');
async function operation(name: string, value?: unknown): Promise<unknown> {
  const response = await fetch(endpoint + name, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`survey storage ${name}: ${response.status}`);
  return response.json();
}
export const store = {
  async mine(subject: string): Promise<SavedAnswer | null> {
    const value = await operation('mine', { subject });
    if (value !== null && !savedAnswer(value)) throw new Error('Invalid saved answer');
    return value;
  },
  async saveAnswer(subject: string, answer: Answer): Promise<void> {
    const value = await operation('save', { subject, answer });
    if (!record(value) || value.ok !== true) throw new Error('Invalid save response');
  },
  async results(): Promise<{ answers: SavedAnswer[] }> {
    const value = await operation('results');
    if (!record(value) || !Array.isArray(value.answers) || !value.answers.every(savedAnswer)) throw new Error('Invalid results');
    return { answers: value.answers };
  },
  async exportState(): Promise<ExportState> {
    const value = await operation('export-state');
    if (!exportState(value)) throw new Error('Invalid export state');
    return value;
  },
};
