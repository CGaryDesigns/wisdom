'use strict';

//initialize constants
const _ = require('underscore');
const cheerio = require('cheerio');
const figlet = require('figlet');
const fs = require('fs');
const oauthProvider = require('simple-oauth2');
const path = require('path');
const program = require('commander');
const Queue = require('better-queue');
const readline = require('readline');
const request = require('request');
const s = require('underscore.string');
const urlparser = require('url-parse');
require('dotenv').config();

//set up the program and process the incoming variables.
program
    .version('1.0.0')
    .option('-u --username <required>','the user name for the source Salesforce instance.')
    .option('-p --password <required>','the password for the source Salesforce instance')
    .option('-l --pagelimit [optional]','the limit the the number of pages of knowledge articles to process',parseInt)
    .parse(process.argv);

//set up some initial global variables
let sfdcInfo = {};
//main application object
let wisdom = {};
//function to authorize application with source org
wisdom.authorize = (callback) => {
    wisdom.data.page_limit = (_.isUndefined(program.pagelimit) ? 10001:program.pagelimit);
    console.log('Beginning the Journey for...');
    //create oauth config item
    let credentials = {
        client:{
            id: process.env.CLIENT_ID,
            secret: process.env.CLIENT_SECRET
        },
        auth:{
            tokenHost:process.env.TOKEN_HOST,
            tokenPath:process.env.TOKEN_PATH,
            authorizePath:process.env.TOKEN_AUTHORIZE
        }
    };
    let tokenConfig = {
        username: program.username,
        password: program.password
    };
    let oauth2 = oauthProvider.create(credentials);
    oauth2.ownerPassword.getToken(tokenConfig)
        .then(
            (result)=>{
                let tokenObj = oauth2.accessToken.create(result);
                wisdom.access_token = tokenObj.token.access_token;
                wisdom.utils.instanceUrl = tokenObj.token.instance_url;
                callback();
            },
            (err)=>{
                console.log('There was a problem authenticating.');
                throw err;
            }
        );

}
wisdom.articleObjectDataQueue = new Queue((input,callback)=>{
                                            console.log('Working on getting details for Article Type %s.',input.name);
                                            wisdom.obtainArticleTypeDetail(input,callback);
                                        },{afterProcessDelay:1000})
                                        .on('drain',()=>{
                                            console.log('Done Getting article type data');
                                            wisdom.createArticleStorageStructure(()=>{
                                                let initialArticleUrl = wisdom.utils.host + wisdom.utils.kbPath + '?pageSize='+wisdom.data.article_page_size;
                                                wisdom.obtainArticleSummaryPage(initialArticleUrl,()=>{
                                                    console.log('All done getting Article Pages. Going to Process Articles now..');
                                                    _.each(wisdom.data.articleUrlList,(element,index,list)=>{
                                                        wisdom.articleProcessingQueue.push(element);
                                                    });
                                                });
                                            });
                                        });
wisdom.articleProcessingQueue = new Queue((input,callback)=>{
                                            console.log('Processing article In Queue..');
                                            wisdom.obtainArticleDetail(input,callback);
                                         },{afterProcessDelay:1000})
                                         .on('task_finish',(taskId,result)=>{
                                            console.log('Completed Processing %s',taskId);
                                            let stats = wisdom.articleProcessingQueue.getStats();
                                            console.log('Total Tasks processed: %s of %s - %s percent complete.',stats.total,wisdom.data.articleUrlList.length,Math.round(((stats.total/wisdom.data.articleUrlList.length)*100)));
                                         })
                                         .on('drain',()=>{
                                             console.log('All Done Processing Articles.. now to get images');
                                             _.each(wisdom.data.articleImgUrlList,(element,index,list)=>{
                                                 wisdom.articleImageProcessing.push(element);
                                             });
                                         });
wisdom.articleImageProcessing = new Queue((input,callback)=>{
                                           console.log('Trying to get Image %s.',input);
                                           wisdom.obtainImage(input,callback);
                                        },{afterProcessDelay:1000})
                                        .on('drain',()=>{
                                            console.log('All Done.');
                                        });
wisdom.extractArticles = ()=>{
    figlet('Wisdom',(err,data)=>{
        if(err){
            console.log('header stuff went wrong.');
            throw err;
        }
        console.log(data);
        console.log('Executing extractArticles.');
        console.log('Going to Find Knowledge Article Types...');
        wisdom.obtainArticleTypeData(()=>{
            _.each(wisdom.data.articleTypes,(value,key,list)=>{
                wisdom.articleObjectDataQueue.push(value);
            });
        });
    });
};
wisdom.obtainArticleTypeData = (callback)=>{
    let sObjectRequestUrl = wisdom.utils.host + wisdom.utils.objPath;
    request.get(sObjectRequestUrl,wisdom.utils.createServiceRequestOptions())
        .on('response',(incomingMsg)=>{
            let responseData = '';
            let responseObj = {};
            incomingMsg
                .on('data',(chunk)=>{
                    responseData += chunk.toString('utf8');
                })
                .on('end',()=>{
                    responseObj = JSON.parse(responseData);
                    let articleTypeSObjectList = [];
                    _.each(responseObj.sobjects,(element,index,list)=>{
                        if(s.endsWith(element.name,'__ka')) wisdom.data.articleTypes[element.keyPrefix]=element;
                    })
                    callback();
                });
        })
        .on('error',(err)=>{
            console.log('There was an error getting the Global Describe');
            throw err;
        });
};
wisdom.obtainArticleTypeDetail = (articleTypeObj,callback)=>{
    let describeUrl = wisdom.utils.host + wisdom.utils.objPath + '/' + articleTypeObj.name + 'v' + '/describe/';
    request.get(describeUrl,wisdom.utils.createServiceRequestOptions())
        .on('response',(incomingMsg)=>{
            let responseData = '';
            let responseObj = {};
            incomingMsg
                .on('data',(chunk)=>{
                    responseData += chunk.toString('utf8');
                })
                .on('end',()=>{
                    responseObj = JSON.parse(responseData);
                    wisdom.data.articleTypes[articleTypeObj.keyPrefix] = responseObj;
                    callback();
                });
        })
        .on('error',(err)=>{
            console.log('Error obtaining describe for %s.',articleTypeObj.name);
            throw err;
        })
}
wisdom.createArticleStorageStructure = (callback)=>{
    console.log('Executing createArticleStorageStructure');
    _.each(wisdom.data.articleTypes,(value,key,list)=>{
        let dirPath = path.join(__dirname,process.env.DIR_ARTICLEDATA,s.rtrim(value.name,'v'));
        fs.mkdir(dirPath,(err)=>{
            if(err && err.message.substr('EEXIST')==-1){
                console.log('Could not create directory %s.',dirPath);
                throw err;
            }
            try{
                fs.mkdirSync(path.join(dirPath,'html'));
                fs.mkdirSync(path.join(dirPath,'images'));
            } catch(err) {
                //TODO: need to make sure these don't exist
            }
            let fileData = wisdom.utils.createCSVFileHeader(value);
            let fileName = path.join(dirPath,s.rtrim(value.name,'v')+'.csv');
            fs.writeFile(fileName,fileData+"\n",(err)=>{
                if(err){
                    console.log('Error writing file %s.',fileName);
                    throw err;
                }
            });
        });
    });
    callback();
};
wisdom.obtainArticleSummaryPage = (articlePageUrl,callback)=>{
    console.log('Executing obtainArticle Summary for URL %s.',articlePageUrl);
    if(_.isUndefined(wisdom.data.page_count)) wisdom.data.page_count = 1;
    request.get(articlePageUrl,wisdom.utils.createServiceRequestOptions())
        .on('response',(incomingMsg)=>{
            let responseData = '';
            let responseObj = {};
            incomingMsg
                .on('data',(chunk)=>{
                    responseData += chunk.toString('utf8');
                })
                .on('end',()=>{
                    responseObj = JSON.parse(responseData);
                    _.each(responseObj.articles,(element,index,list)=>{
                        wisdom.data.articleUrlList.push(element);
                    });
                    if(_.has(responseObj,'nextPageUrl') && (wisdom.data.page_count < wisdom.data.page_limit)){
                        wisdom.data.page_count++;
                        wisdom.obtainArticleSummaryPage(wisdom.utils.host+responseObj.nextPageUrl,callback);
                    } else {
                        callback();
                    }
                })
                .on('error',(err)=>{
                    console.log('There was an error parsing the article Response.');
                    throw err;
                })
        })
        .on('error',(err)=>{
            console.log('There was a problem obtaining response from %s.',articlePageUrl);
            throw err;
        });
};
wisdom.obtainArticleDetail = (articleSumObj,callback)=>{
    console.log('executing obtainArticleDetail');
    let fullArticleUrl = wisdom.utils.host + articleSumObj.url;
    request.get(fullArticleUrl,wisdom.utils.createServiceRequestOptions())
        .on('response',(incomingMsg)=>{
            let responseData = '';
            let responseObj = {};
            incomingMsg
                .on('data',(chunk)=>{
                    responseData += chunk.toString('utf8');
                })
                .on('end',()=>{
                    responseObj = JSON.parse(responseData);
                    wisdom.sortAndSaveArticle(responseObj,callback);
                });
        })
        .on('error',(err)=>{
            console.log('There was a problem getting the Article Details for %s.',articleSumObj.id);
            console.log(err.message);
            callback();
        });
};
wisdom.sortAndSaveArticle = (articleObj,callback)=>{
    console.log('executing sortAndSaveArticle');
    //first lets figure out where to save this data
    let keyPrefix = articleObj.id.substr(0,3);
    let articleType = wisdom.data.articleTypes[keyPrefix];
    let dirPath = path.join(__dirname,process.env.DIR_ARTICLEDATA,s.trim(articleType.name,'v'));
    let fileName = path.join(dirPath,articleObj.id+'.json');
    
    let csvHeader;
    let lineCounter = 0;
    let fileLineReader = readline.createInterface({
                            input:fs.createReadStream(path.join(dirPath,s.rtrim(articleType.name,'v')+'.csv'))
                        })
                        .on('line',(line)=>{
                            if(lineCounter < 1){
                                csvHeader = line;
                            } else {
                                fileLineReader.close();
                            }
                            lineCounter++;
                        })
                        .on('error',(err)=>{
                            console.log('could not read file header:');
                            throw err;
                        })
                        .on('close',()=>{
                            console.log('About to write the Article data to the CSV File...');
                            wisdom.processArticleLayoutFields(articleObj,csvHeader,callback);
                        });
    
    fs.writeFile(fileName,JSON.stringify(articleObj,null,"\t"),(err)=>{
        if(err){
            console.log('There was a problem writing the details of article %s.',articleObj.id);
        }
    });
};
wisdom.processArticleLayoutFields = (articleObj,csvHeader,callback)=>{
    console.log('executing processArticleLayoutFields');
    //first lets create an object to hold the values we will be writing.
    let csvHeaderArray = csvHeader.split(',');
    let csvLineObj = {};
    let articleType = wisdom.data.articleTypes[articleObj.id.substr(0,3)];
    //now lets go through the header Array and find the object value
    _.each(csvHeaderArray,(element,index,list)=>{
        if(_.isUndefined(articleObj[element.toLowerCase()])){
            console.log('Could not find field %s in %s. Looking in layout Items:',element,articleObj.id);
            let displayItem = _.find(articleObj.layoutItems,(item)=>{item.name.toLowerCase()==element.toLowerCase()},element);
            if(_.isUndefined(displayItem)){
                console.log('Could not find value for %s. field at all. marking as empty..',element);
                csvLineObj[element] = s.quote('','"');
            } else {
                if(displayItem.type=='RICH_TEXT_AREA'){
                    let fileNamePart = articleObj.id + '-'+Date.now()+'.html';
                    let fileName = path.join(__dirname,process.env.DIR_ARTICLEDATA,s.rtrim(articleType.name,'v'),'html',fileNamePart);
                    fs.writeFileSync(fileName,displayName.value);
                    csvLineObj[element] = s.quote('html/'+fileNamePart,'"');
                    console.log('%s field was a RICH_TEXT_AREA. Wrote value to %s.',displayItem.name,csvLineObj[element]);
                    wisdom.extractImageUrls(displayItem.value,articleObj,articleType);
                } else {
                    csvLineObj[element] = s.quote(displayItem.value);
                }
            }
        } else {
            csvLineObj[element] = s.quote(articleObj[element.toLowerCase()]);
        }
    });
    let csvLineArray =[];
    _.each(csvHeaderArray,(fieldName,index,list)=>{csvLineArray.push(csvLineObj[fieldName])});
    let csvLine = s.join(',',csvLineArray);
    let csvAppendFile = path.join(__dirname,process.env.DIR_ARTICLEDATA,s.rtrim(articleType.name,'v'),s.rtrim(articleType.name,'v')+'.csv');
    fs.appendFile(csvAppendFile,csvLine+"\n",(err)=>{
        if(err){
            console.log('cannot write to file');
            throw err;
        }
        callback();
    });
};
wisdom.extractImageUrls = (htmlString,articleObj,articleType)=>{
    let $ = cheerio.load('<div>'+htmlString+'</div>');
    $('img').each((index,element)=>{
        console.log('Grabbing img %s',$(element).attr('src'));
        wisdom.data.articleImgUrlList.push($(element).attr('src'));
    });
};
wisdom.obtainImage = (imageUrl,callback)=>{
    console.log('executing obtainImage');
    //first lets parse the URL, get the domain, and create a cookie for it.
    let urlInfo = new urlparser(imageUrl);
    //setting up cookie
    let cookieJar = request.jar();
    cookieJar.setCookie(request.cookie('sid='+wisdom.access_token),urlInfo.hostname);
    //build header
    let requestOpt = {
        headers:{
            'Cookie':'sid='+wisdom.access_token,
            'Accept-Language':'en-US'
        }
    }
    //console.log('URL Parts: %s',JSON.stringify(urlInfo));
    
    request.get(imageUrl,requestOpt)
        .on('response',(incomingMsg)=>{
            console.log('response Received for Image:');
            console.log(incomingMsg.headers);
            incomingMsg.pipe(process.stdout).on('end',()=>{callback()});
        })
        .on('error',(err)=>{
            console.log('There was a problem obtaining the response. Error: %s',err.message);
            callback();
        });
};
wisdom.utils = {
    createServiceRequestOptions: ()=>{
        let requestOptions = {
            headers: {
                'Authorization':'Bearer ' + wisdom.access_token,
                'Accept-Language':'en-US'
            }
        }
        return requestOptions;
    },
    createCSVFileHeader: (describeObj)=>{
        let fieldList = [];
        _.each(describeObj.fields,(element,index,list)=>{
            fieldList.push(element.name);
        });
        return s.join(',',fieldList);
    },
    host: 'https://na88.salesforce.com',
    kbPath: '/services/data/v41.0/support/knowledgeArticles',
    dcPath: '/services/data/v41.0/support/dataCategoryGroups',
    objPath: '/services/data/v41.0/sobjects',
    instanceUrl: ''
};
wisdom.data = {
    articleUrlList:[],
    articleTypes:{},
    articleImgUrlList:[],
    page_limit:1001,
    article_page_size:50
};
//Begin Processing
wisdom.authorize(wisdom.extractArticles);


