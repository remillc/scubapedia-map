import fs from 'fs'
import { join } from 'path'
import axios from 'axios'
// import extractUrls from 'extract-urls'
import jQuery from 'jquery'
import { JSDOM } from 'jsdom'
import Handlebars from 'handlebars'
import wait from 'wait'
import ProgressBar from 'progress'
import archiver from 'archiver'

const pkg = require(join(__dirname, '..', 'package.json'))

const $ = jQuery((new JSDOM('')).window)

const waitInterval = 50; // 50ms

var missedArticles = [];
var successArticlesCount = 0;

class Site {
  constructor({ } = {}) {
    this.url = null;
    this.title = null;
    this.description = null;
    this._style = fs.readFileSync(join(__dirname, './kmz-template/style.css'), { encoding: 'utf-8' })
  }

  async load(url) {
    return new Promise((resolve, reject) => {
      axios
        .get(url)
        .then(response => {
          if (response.status !== 200) {
            missedArticles.push(url)
            return reject(new Error(response.status))
          }

          try {
            const html = response.data;
            const $page = $(html);
            this.title = $page.find('#firstHeading').text();
            this.url = url;
            this.description = getDescription(html, url, this._style)
            this.coordinates = getCoordinates(html, this.title)

            return resolve();
          } catch (e) {
            // console.log(html)
            console.error(e)
            reject(e)
          }
        })
        .catch(function (error) {
          missedArticles.push(url)
          if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            // console.log(error.response.data);
            console.log(error.response.status);
            console.log(error.response.headers);
          } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js
            console.log(error.request);
          } else {
            // Something happened in setting up the request that triggered an Error
            console.log('Error', error.message);
          }
          console.log(error.config);
        })
    })

  }
}

async function getSitesList() {
  return new Promise((resolve, reject) => {

    axios
      .get('http://scubapedia.ca/index.php/Sp%C3%A9cial:Toutes_les_pages')
      .then(res => {
        // console.log(res)
        return res.data
      })
      // .then(data => $.load(data))
      .then(data => $(data))
      .then($doc => {
        try {
          const ret = [];
          $doc.find('.mw-allpages-chunk > li:not(.allpagesredirect)').each((i, list) => {
            // console.log(list)
            $(list).find('> a[href]').each((i, node) => {
              // console.log(node)
              if ($(node).text() !== 'Accueil') {
                const url = new URL($(node).attr('href'), 'http://scubapedia.ca')
                ret.push(url.href)
              }
            })
          });
          resolve(ret);
        } catch (e) {
          console.error(e);
          reject(e)
        }
      })
      .catch(e => {
        console.error(e);
        reject(e)
      })
  })
}

function getCoordinates(htmlPage, name) {

  try {

    const $page = $(htmlPage);

    let url, coords;

    var $urls = $page.find('a[href *= "://maps.google."]').filter((i, node) => {
      return /^https?:\/\/maps\.google\.[^\/]+\/maps/.test(node.href)
    });

    if ($urls.length > 0) {
      url = $urls.first().attr('href')
      // console.debug('Found URL from Google Map link')
    } else {
      // Checking in page map data

      const data = $page.find('#map_google3_1 > .mapdata').text();
      // console.log(htmlPage)
      if (data) {
        coords = JSON.parse(data).locations[0];

        // console.debug('Found coordinages through map data')
        successArticlesCount++;
        return `${coords.lon},${coords.lat},0`
      }
    }
    // const urls = extractUrls(content);
    // const url2 = urls.find(url => url.indexOf('//maps.google.') > 0)


    if ($urls.length !== 1) {
      const urls = $.map($urls, url => url.href)
      // console.log('\n========== %s ========== at %s: %o', $urls.length, name, urls)
    }

    if (typeof url === 'undefined') {
      // console.error('\nNo google map URL found for %s', name)
      missedArticles.push(name)
      return false;
    }

    const gmapUrl = new URL(url)

    if (!gmapUrl.searchParams.has('ll')) {
      missedArticles.push(name)
      return false;
    }

    coords = gmapUrl.searchParams.get('ll').split(',');

    successArticlesCount++;
    return `${coords[1]},${coords[0]},0`

  } catch (e) {
    missedArticles.push(name)
    console.log('\n')
    console.error('Problem extracting coordinates for site %s', name)
    console.error(htmlPage)
    console.error(e)
    // process.exit()
    return false;
  }
}

function getDescription(html, url, style) {
  const $description = $(`<div><base href="${url}" />${$(html).find('#bodyContent').html()}</div>`)
  $description.find('#siteSub, #jump-to-nav, .printfooter, .mw-jump-link, #contentSub, #map_google3_1, #catlinks').remove()
  $description.find('#Description').parent().remove();
  $description.find('img').each((i, node) => {
    try {
      const absUrl = new URL(node.src, url);
      $(node).attr('src', absUrl.href)
    } catch (e) {
      console.error(`Could not create absolute URL for image. Error %o`, e)
    }
  })
  $description.find('a[href]').not('[href="#"]').not('[href=""]').each((i, node) => {
    try {
      const absUrl = new URL(node.href, url);
      $(node).attr('href', absUrl.href)
    } catch (e) {
      console.error(`Could not create absolute URL for link. Error %o`, e)
    }
  })
  $description.append(`<a href="${url}" class="lien-scubapedia">Lien Scubapedia</a>`)
  $description.prepend(`<style>\n${style}\n</style>`)
  return `<div>${$description.html()}</div>`;
}


/*
 * main program
 */

async function main() {
  try {
    const sites = [];
    console.log('Loading sites list')
    const list = await getSitesList();

    const listLength = list.length;
    // const listLength = 2;

    console.log('List loaded. Found %s articles on Scubapedia', listLength)

    let i = 0
    const bar = new ProgressBar('[:bar] :percent :etas', {
      total: listLength,
      width: 20,
      incomplete: ' '
    })

    console.log('Loading and processing sites...')

    for (var ii = 0; ii < listLength; ii++) {
      i++;
      const item = list[ii]
      const site = new Site()
      await site.load(item)
      bar.tick(1)
      sites.push(site)
      await wait(waitInterval)
      // console.log(site)
    }

    sites.sort((a, b) => {
      a = a.title.toUpperCase();
      b = b.title.toUpperCase();
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })

    const templateFile = fs.readFileSync(join(__dirname, 'kml.template'), { encoding: 'utf8' })
    const template = Handlebars.compile(templateFile)

    const doc = template({
      version: pkg.version,
      sites: sites.filter(site => site.coordinates)
    })

    const kmz = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
    });

    const kmzFile = fs.createWriteStream(join(__dirname, '..', 'build', 'scubapedia.kmz'))

    kmz.directory(join(__dirname, 'kmz-template', 'images'), 'images')

    kmz.append(doc, {
      name: 'doc.kml'
    })

    kmz.pipe(kmzFile)

    kmz.finalize()

    console.log('%s articles where processed successfully.', successArticlesCount)
    console.log('%s missed articles: %o', missedArticles.length, missedArticles)
  } catch (e) {
    console.error(e)
  }
}

main()

// (async () => {
//   const site = new Site()
//   await site.load('http://scubapedia.ca/index.php/Antigua')
//   console.log(site.coordinates)
// })()