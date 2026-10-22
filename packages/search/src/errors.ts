export type SearchErrorCode=
 |'SEARCH_QUERY_DENIED'|'SEARCH_CLASSIFICATION_DENIED'|'SEARCH_CANCELLED'
 |'SEARCH_TIMEOUT'|'SEARCH_UNAVAILABLE'
 |'SEARCH_URL_DENIED'|'SEARCH_DNS_DENIED'|'SEARCH_FETCH_TIMEOUT'|'SEARCH_FETCH_NETWORK_FAILED'
 |'SEARCH_FETCH_REDIRECT_INVALID'|'SEARCH_FETCH_REDIRECT_LIMIT'|'SEARCH_FETCH_REJECTED'
 |'SEARCH_FETCH_SIZE_LIMIT'|'SEARCH_FETCH_ENCODING_DENIED'|'SEARCH_FETCH_TYPE_DENIED'
 |'SEARCH_PROVIDER_INVALID_REPLY';
/** Fixed, content-free errors. Messages never include the denied query, URL or provider body. */
export class SearchError extends Error {
 constructor(readonly code:SearchErrorCode,readonly status=403,options?:ErrorOptions){super(code,options);}
}
