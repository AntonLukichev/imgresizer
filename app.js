const axios = require('axios')
const sharp = require('sharp')
const qs = require('querystring')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const boom = require('boom')

const fastify = require('fastify')({
  logger: true
})
const CONFIG = require('./config')

fastify.register(require('fastify-url-data'), (err) => { if (err) throw err })
// fastify.register(require('fastify-response-time'))
fastify.register(require('fastify-static'), { root: __dirname })

fastify.get('/ping', async (req, rep) => {
  rep.send({ pong: true })
})

const getFormat = (format) => {
  return CONFIG.allowFormat.includes(format) ? format : CONFIG.defaultFormat
}

const parseReq = (url, acceptWebp) => {
  const hash = crypto.createHash('md5')
  let data = {}
  data.query = qs.parse(url.query)
  //  parsing parameters in equest
  data.img = {}
  data.img.w = parseInt(data.query.w) || CONFIG.defaultWidth
  data.img.h = parseInt(data.query.h) || CONFIG.defaultHeight
  data.img.q = parseInt(data.query.q) || CONFIG.defaultQuality
  if (acceptWebp && !data.query.fm) {
    data.img.fm = 'webp'
  } else {
    data.img.fm = getFormat(data.query.fm)
  }
  //  query formation
  delete data.query.w
  delete data.query.h
  delete data.query.q
  delete data.query.fm
  data.uri = url.path + '?' + qs.stringify(data.query)
  data.filename = url.path
  data.base64 = Buffer.from(data.uri).toString('base64')
  data.sourceFilename = hash.update(data.base64).digest('hex')
  return data
}

const isFileExists = (filename) => {
  return fs.existsSync(filename)
}

const getFileSize = (filePath) => {
  const stat = fs.statSync(filePath)
  const size = stat.size
  let i = Math.floor(Math.log(size) / Math.log(1024))
  return (size / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]
}

const isAcceptWebp = (accept) => {
  const patternWebp = /image\/webp/
  return !!accept.match(patternWebp)
}

const getSourceFilename = (reqImg) => {
  return path.join(
    CONFIG.originalFolder,
    reqImg.sourceFilename
  )
}

const getDestFileName = (reqImg) => {
  const filename = reqImg.sourceFilename
  const img = reqImg.img
  const imgW = img.w ? `_w${img.w}_` : ``
  const imgH = img.h ? `_h${img.h}_` : ``
  const imgQ = img.q ? `q${img.q}.` : `.`
  const ext = img.fm
  // ToDo add another formats
  return path.join(
    CONFIG.destinationFolder,
    filename + imgW + imgH + imgQ + ext)
}

const isAllowFileType = (contentType) => {
  // !contentType.startsWith('image/')
  return CONFIG.allowFormat.includes(contentType)
}

const processingImg = async (settings, rep) => {
  const imgOptions = {
    width: settings.img.w,
    height: settings.img.h,
    quality: settings.img.q,
    fit: CONFIG.defaultFit
  }
  let successful = false
  let options = {}
  let imgFormat = 'jpeg'
  switch (settings.img.fm) {
    case 'webp':
      options = { ...CONFIG.webpOptions,
        quality: settings.img.q
      }
      imgFormat = 'webp'
      break
    default:
      options = { ...CONFIG.jpegOptions,
        quality: settings.img.q
      }
      break
  }
  sharp.cache(false)
  sharp(settings.source)
    .resize(imgOptions)
    .toFormat(imgFormat, options)
    .toFile(settings.destination)
    .then((info) => {
      fastify.log.info(info)
      successful = true
      rep.sendFile(settings.destination)
    })
    .catch((error) => {
      fastify.log.error(error)
      rep.send(error)
    })
  return successful
}

const getDownloadFile = async (settings, rep) => {
  if (isFileExists(settings.source)) {
    console.log('source img exists')
    return processingImg(settings, rep)
  } else {
    const axiosGetFile = axios.create(CONFIG.axiosConfig)
    const writeStream = fs.createWriteStream(settings.source)
    writeStream.on('finish', () => {
      console.log('save file finish')
      return processingImg(settings, rep)
    })
    const respData = await axiosGetFile(settings.url)
      .then(async (response) => {
        if (isAllowFileType(response.headers['content-type']) && response.status === 200) {
          console.log(`download complete ${settings.url} -> ${response.status} ${response.headers['content-length']} ${response.headers['content-type']}`)
          response.data.pipe(writeStream)
          return response.data
        } else {
          boom.unsupportedMediaType('source file incorrect format')
        }
      })
      .catch((error) => {
        rep.send(error)
      })
    return respData
  }
}

const getSettings = (req) => {
  const urlData = req.urlData()
  const acceptWebp = isAcceptWebp(req.headers.accept)
  const reqImg = parseReq(urlData, acceptWebp)
  const downFile = CONFIG.baseURL + reqImg.uri

  const sourceFilename = getSourceFilename(reqImg)
  const destFilename = getDestFileName(reqImg, acceptWebp)

  return {
    url: downFile,
    img: reqImg.img,
    source: sourceFilename,
    destination: destFilename,
    webp: acceptWebp
  }
}

fastify.get(`${CONFIG.pathURI}*`, async (req, rep) => {
  const settings = getSettings(req)
  fastify.log.info('settings request:', settings)

  if (isFileExists(settings.destination)) {
    console.log('img exists')
    rep.sendFile(settings.destination)
  } else {
    await getDownloadFile(settings, rep)
  }
})

const start = async () => {
  try {
    await fastify.listen(CONFIG.httpPort, CONFIG.httpHost, (err, address) => {
      if (err) {
        fastify.log.error(err)
        process.exit(1)
      }
    })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
