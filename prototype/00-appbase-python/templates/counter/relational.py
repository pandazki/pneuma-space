"""Small parameterized SQL transaction adapter; SQL itself must be portable."""
from contextlib import contextmanager
from string import Formatter
from store import Database


def _compile(template, parameters, backend):
    """Replace only bare {} fields. Use {{ and }} for literal SQL braces."""
    if not isinstance(template, str):
        raise TypeError("SQL template must be a string")
    pieces, count = [], 0
    for literal, field, spec, conversion in Formatter().parse(template):
        # Psycopg uses % for parameter markers; escape literal SQL percent signs.
        pieces.append(literal.replace('%', '%%') if backend == 'postgres' and parameters else literal)
        if field is not None:
            if field != '' or spec or conversion:
                raise ValueError('only bare {} value placeholders are supported')
            pieces.append('?' if backend == 'sqlite' else '%s')
            count += 1
    if count != len(parameters):
        raise ValueError('SQL placeholder count does not match parameter count')
    return ''.join(pieces)


class Session:
    def __init__(self, connection, backend):
        self._connection, self._backend = connection, backend

    def execute(self, sql, *parameters):
        statement = _compile(sql, parameters, self._backend)
        # With no parameters, do not trigger psycopg's placeholder processing.
        if not parameters:
            return self._connection.execute(statement)
        return self._connection.execute(statement, parameters)


class RelationalDatabase:
    def __init__(self, backend, path=None):
        self._database = Database(backend, path)
        self.backend = backend

    @contextmanager
    def transaction(self, *, write=True):
        """Commit on success, rollback on exception. `write` is a locking hint."""
        with self._database.transaction() as connection:
            if self.backend == 'sqlite':
                # Explicitly begin before any SELECT; Python sqlite3's legacy
                # implicit transactions otherwise begin only at the first write.
                connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield Session(connection, self.backend)
