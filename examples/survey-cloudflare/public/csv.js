const csvCell = (value) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
export const csv = (answers) => ['subject,q1,q2,q3,submitted_at', ...answers.map((a) =>
  [a.subject, a.q1, a.q2, a.q3, a.submittedAt].map(csvCell).join(','))].join('\n') + '\n';
