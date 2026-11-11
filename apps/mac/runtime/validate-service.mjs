import {serviceURL} from './account-client.mjs';try{console.log(serviceURL(process.argv[2]));}catch{process.exit(1);}
