const crypto = require('crypto');

function securityHeaders(req,res,next){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
}
function generateToken(prefix=''){ return prefix+crypto.randomBytes(24).toString('hex'); }
module.exports={securityHeaders,generateToken};
