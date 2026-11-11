import http from 'node:http';
// Respect this process's existing authorized proxy. No system/user settings are
// changed. Loopback APIs must always stay on the local machine.
if(typeof http.setGlobalProxyFromEnv==='function'&&(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy)){
 http.setGlobalProxyFromEnv({...process.env,no_proxy:[process.env.no_proxy??process.env.NO_PROXY??'','127.0.0.1','localhost','::1'].join(',')});
}
