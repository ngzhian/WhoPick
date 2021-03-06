require('dotenv').config({
    silent: process.env.NODE_ENV === 'production'
});

var TelegramBot = require('node-telegram-bot-api');
var sprintf = require("sprintf-js").sprintf;
var mysql = require('mysql');

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === '<token>' || !process.env.DB_URL || process.env.DB_URL === '<db url>') {
    console.log('ERROR: env variable not set.');
    return;
}

var connection = mysql.createConnection(process.env.DB_URL);
var isProduction = process.env.NODE_ENV === 'production'
var token = process.env.BOT_TOKEN;
var bot = isProduction ?
    new TelegramBot(token, {
        webHook: {
            port: process.env.PORT,
            host: '0.0.0.0'
        }
    }) :
    new TelegramBot(token, {
        polling: true
    });

if (isProduction) {
    bot.setWebHook('https://whopick.herokuapp.com/bot' + token);
}

var matched = false;
var questionMap = new Map(); // value -1 = need question, > 0 = need choice

// Matches /start
bot.onText(/\/start/, function(msg, match) {
    matched = true;
    questionMap.set(msg.from.id, -1);
    bot.sendMessage(msg.from.id, 'Let\'s create a new poll. First, send me the question.');
});

// Matches /done
bot.onText(/\/done/, function(msg, match) {
    matched = true;

    var questionId = questionMap.get(msg.from.id);
    if (questionId > 0) { // currently creating a poll
        connection.query('UPDATE question SET ? WHERE question_id = ?', [{
            is_enabled: 1
        }, questionId], function(err, result) {
            if (err && !isProduction) throw err;
            questionMap.delete(msg.from.id);

            var reply = 'Poll created. You can now publish it to a group or send it to your friends in a private message. To do this, tap the button below or start your message in any other chat with @WhoPickBot and select one of your polls to send.\n\n';

            connection.query('SELECT question.question_id, question, choice.choice_id, choice FROM question LEFT JOIN choice ON question.question_id = choice.question_id LEFT JOIN vote ON choice.choice_id = vote.choice_id WHERE question.question_id = ?', questionId, function(err, result) {
                if (err && !isProduction) throw err;
                var polls = parseResult(result);
                var poll = polls[questionId];
                opts = {
                    parse_mode: 'Markdown',
                    reply_markup: getAdminInlineKeyboard(poll.question, questionId)
                }

                bot.sendMessage(msg.from.id, reply + formatPoll(poll), opts);
            });
        });
    } else {
        bot.sendMessage(msg.from.id, 'wtf u trying to do');
    }
});

// Matches all other
bot.onText(/(.*)/, function(msg, match) {
    if (matched) {
        matched = false;
        return;
    }

    var questionId = questionMap.get(msg.from.id);
    if (questionId == -1) {
        connection.query('INSERT INTO question SET ?', {
            user_id: msg.from.id,
            question: match[0]
        }, function(err, result) {
            if (err && !isProduction) throw err;
            questionMap.set(msg.from.id, result.insertId);
            bot.sendMessage(msg.from.id, sprintf('Creating a new poll: \'*%s*\'\n\nPlease send me the first answer option.', match[0]), {
                parse_mode: 'Markdown'
            });
        });
    } else if (questionId > 0) {
        connection.query('INSERT INTO choice SET ?', {
            question_id: questionId,
            choice: match[0]
        }, function(err, result) {
            if (err && !isProduction) throw err;
            bot.sendMessage(msg.from.id, sprintf('Added option: \'*%s*\'\n\nNow send me another answer option.\nWhen you\'ve added enough, simply send /done to finish creating the poll.', match[0]), {
                parse_mode: 'Markdown'
            });
        });
    }
});

bot.on('inline_query', function(msg) {
    connection.query('SELECT q.question_id, question, c.choice_id, choice, v.vote_id, v.user_id, v.name FROM question q LEFT JOIN choice c ON q.question_id = c.question_id LEFT JOIN vote v ON c.choice_id = v.choice_id WHERE q.user_id = ? AND question LIKE ? AND q.is_enabled = 1', [msg.from.id, '%' + msg.query + '%'], function(err, result) {
        if (err && !isProduction) throw err;
        var polls = parseResult(result);
        var reply = [];
        polls.map(function(poll) {
            reply.push({
                type: 'article',
                id: poll.question_id.toString(),
                message_text: formatPoll(poll),
                parse_mode: 'Markdown',
                title: poll.question,
                description: getDescription(poll),
                reply_markup: getInlineKeyboard(poll)
            });
        });

        bot.answerInlineQuery(msg.id, reply, {
            cache_time: 0,
            switch_pm_text: 'Create new poll',
            is_personal: true
        });
    });
});

bot.on('callback_query', function(msg) {
    var commands = msg.data.split(' ');
    switch (commands[0]) {
        case '/vote': // /vote question_id choice_id
            connection.query('SELECT EXISTS(SELECT * FROM vote WHERE choice_id = ? AND user_id = ?) exist', [commands[2], msg.from.id], function(err, result) {
                if (err && !isProduction) throw err;
                if (!result[0].exist) {
                    connection.query('INSERT INTO vote SET ?', {
                        choice_id: commands[2],
                        user_id: msg.from.id,
                        name: msg.from.first_name
                    }, function(err, result) {
                        if (err && !isProduction) {
                            // voting on a closed poll
                            bot.editMessageReplyMarkup(getPollClosedInlineKeyboard(), {
                                inline_message_id: msg.inline_message_id,
                            });
                            return;
                        }
                        updatePoll(msg.inline_message_id, commands[1]);
                    });
                } else {
                    connection.query('DELETE FROM vote WHERE choice_id = ? AND user_id = ?', [commands[2], msg.from.id], function(err, result) {
                        if (err && !isProduction) throw err;
                        updatePoll(msg.inline_message_id, commands[1]);
                    });
                }
            })
            break;
        case '/update': // /update question_id
            updateAdminPoll(msg.message.chat.id, msg.message.message_id, commands[1]);
            break;
        case '/delete': // /delete question_id
            updateAdminPoll(msg.message.chat.id, msg.message.message_id, commands[1]);
            connection.query('DELETE FROM question WHERE question_id = ?', commands[1], function(err, result) {
                if (err && !isProduction) throw err;
                bot.editMessageReplyMarkup(getPollClosedInlineKeyboard(), {
                    chat_id: msg.message.chat.id,
                    message_id: msg.message.message_id
                });
            });
            break;
    }
});

function updatePoll(inlineMessageId, questionId) {
    connection.query('SELECT q.question_id, question, c.choice_id, choice, v.vote_id, v.user_id, v.name FROM question q INNER JOIN choice c ON q.question_id = c.question_id LEFT JOIN vote v ON c.choice_id = v.choice_id WHERE q.question_id = ?', questionId, function(err, result) {
        if (err && !isProduction) throw err;
        var polls = parseResult(result);
        var poll = polls[questionId];
        var opts = {
            inline_message_id: inlineMessageId,
            parse_mode: 'Markdown',
            reply_markup: getInlineKeyboard(poll)
        };
        bot.editMessageText(formatPoll(poll), opts);
    });
}

function updateAdminPoll(chatId, messageId, questionId) {
    connection.query('SELECT q.question_id, question, c.choice_id, choice, v.vote_id, v.user_id, v.name FROM question q INNER JOIN choice c ON q.question_id = c.question_id LEFT JOIN vote v ON c.choice_id = v.choice_id WHERE q.question_id = ?', questionId, function(err, result) {
        if (err && !isProduction) throw err;
        var polls = parseResult(result);
        var poll = polls[questionId];
        var opts = {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: getAdminInlineKeyboard(poll.question, questionId)
        };
        bot.editMessageText(formatPoll(poll), opts);
    });
}

function parseResult(result) {
    var polls = [];
    result.forEach(function(row) {
        if (polls[row.question_id] == null) {
            // create new question
            polls[row.question_id] = {
                question_id: row.question_id,
                question: row.question,
                choices: []
            };
        }
        var question = polls[row.question_id];

        if (question.choices[row.choice_id] == null) {
            // create new choice
            question.choices[row.choice_id] = {
                choice_id: row.choice_id,
                choice: row.choice,
                votes: []
            };
        }
        var choice = question.choices[row.choice_id];

        if (choice.votes[row.vote_id] == null) {
            // create new vote
            choice.votes[row.vote_id] = {
                vote_id: row.vote_id,
                user_id: row.user_id,
                name: row.name
            };
        }
    });
    return polls;
}

function formatPoll(poll) {
    result = sprintf('*%s*', poll.question);

    poll.choices.forEach(function(choice) {
        result += sprintf('\n_%s_\n', choice.choice);

        var counter = 1;
        choice.votes.forEach(function(vote) {
            result += sprintf('%d) %s\n', counter++, vote.name)
        });
    });
    return result;
}

function getInlineKeyboard(poll) {
    var result = [];
    poll.choices.forEach(function(choice, i) {
        // /vote question_id choice_id
        result.push([{
            text: choice.choice,
            callback_data: '/vote ' + poll.question_id + ' ' + choice.choice_id
        }]);
    });
    return {
        inline_keyboard: result
    };
}

function getAdminInlineKeyboard(question, questionId) {
    return {
        inline_keyboard: [
            [{
                text: 'Publish poll',
                switch_inline_query: question
            }],
            [{
                text: 'Update results',
                callback_data: '/update ' + questionId
            }],
            [{
                text: 'Close poll',
                callback_data: '/delete ' + questionId
            }]
        ]
    };
}

function getPollClosedInlineKeyboard() {
    return {
        inline_keyboard: [
            [{
                text: 'Poll Closed',
                callback_data: '0'
            }]
        ]
    };
}

function getDescription(poll) {
    var result = [];
    poll.choices.forEach(function(choice) {
        result.push(choice.choice);
    });
    return result.join(', ');
}
