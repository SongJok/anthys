export function preparePostgresClient():Promise<Record<'pg_dump'|'pg_restore',{path:string;sha256:string;version:string}>>;
