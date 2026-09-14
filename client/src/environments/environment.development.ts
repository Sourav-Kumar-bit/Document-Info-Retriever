// Points at the DEPLOYED backend on purpose — you hit CORS, cold starts and
// real latency now, while they're cheap to fix.
export const environment = {
  production: false,
  apiUrl: 'https://document-info-retriever.onrender.com',
};
