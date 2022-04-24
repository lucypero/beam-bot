import {
  Client,
  Interaction,
  Message,
  Intents,
  GuildMemberRoleManager,
  MessageEmbed,
  MessageActionRow,
  MessageButton,
  ButtonInteraction,
  GuildMember,
  GuildAuditLogsEntry,
  TextChannel,
  PartialGuildMember,
} from "discord.js";
import { Knex, knex } from "knex";

interface WhitelistedChannel {
  channel_id: string;
}

interface WhitelistedUrl {
  url: string;
}

interface WhitelistedUser {
  user_id: string;
}

interface UserRole {
  id: number;
  guild_id: string;
  user_id: string;
  role_id: string;
}

interface ServerID {
  server_id: string;
  description: string;
  ord: number;
  the_id: string;
}

enum DBError {
  DuplicateError,
  OtherError,
}

const embed_color = "#0099ff";

//server ID's and its relevant channels
// Channel id of the audit log

type Server_IDs = Map<string, RelevantIDs>;
interface RelevantIDs {
  audit_log_channel_id: string;
  // Role of someone who can whitelist anything
  whitelist_mod_roles: string[];
  // Role of someone who can post any url
  whitelisted_roles: string[];
  // Role of someone who read the rules and can access the server
  user_role: string;
  // Stream, Video, Ark pve, Ark Deathmatch
  // THE ORDER HERE MATTERS !!!
  menu_roles: string[];
}

async function main() {
  console.log("Bot is starting...");

  // open the database
  const config: Knex.Config = {
    client: "sqlite3",
    connection: {
      filename: "./data.db",
    },
    useNullAsDefault: true,
  };

  const knex_instance = knex(config);

  const server_ids = await get_server_ids(knex_instance);

  const client = new Client({
    intents: [
      Intents.FLAGS.GUILDS,
      Intents.FLAGS.GUILD_MESSAGES,
      Intents.FLAGS.GUILD_MEMBERS,
    ],
  });

  // ready listener
  client.on("ready", async () => {
    if (!client.user || !client.application) {
      return;
    }

    console.log(`${client.user.username} is online`);

    // Run the audit log check periodically
    run_audit_log(client, knex_instance, server_ids);

    //for debug. delete later
    //print_all_audit_logs(client);
  });

  // member remove listener
  // used to record their roles in case they come back.
  client.on("guildMemberRemove", (member: GuildMember | PartialGuildMember) => {
    console.log("member left");
    const the_roles = Array.from(member.roles.cache.keys());

    knex_instance<UserRole>("user_roles")
      .where({
        guild_id: member.guild.id,
        user_id: member.user.id,
      })
      .del()
      .then((entries_deleted) => {
        console.log(
          "deleted all the role entries for user ",
          member.user.id,
          "number of deleted rows: ",
          entries_deleted
        );
      })
      .catch(console.error);

    for (const role of the_roles) {
      knex_instance<UserRole>("user_roles")
        .insert({
          guild_id: member.guild.id,
          user_id: member.user.id,
          role_id: role,
        })
        .catch((e) => {
          switch (get_db_error(e)) {
            case DBError.DuplicateError: {
              break;
            }
            case DBError.OtherError: {
              console.log(e);
              break;
            }
          }
        });
    }
  });

  client.on("guildMemberAdd", (member: GuildMember) => {
    // add video and stream role to new members

    const ids = server_ids.get(member.guild!.id);

    if (!ids) {
      console.log("The server that you are in is not in the database.");
      return;
    }

    member.roles
      .add([ids.menu_roles[0], ids.menu_roles[1]])
      .catch(console.error);

    knex_instance
      .select("role_id")
      .from("user_roles")
      .where({
        guild_id: member.guild.id,
        user_id: member.user.id,
      })
      .then((role_id_arr) => {
        if (role_id_arr.length != 0) {
          role_id_arr = role_id_arr.map((role_dict) => role_dict.role_id);

          member.roles
            .add(role_id_arr)
            .then((_) => {
              console.log("roles were added back to the returning member.");
            })
            .catch(console.error);
        }
      });
  });

  // interactionCreate listener
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.guild) return;

    //Button category
    const but_cat = interaction.customId.split("-")[0];

    switch (but_cat) {
      case "roles": {
        clicked_but_roles(interaction, server_ids);
        break;
      }
      case "rules": {
        clicked_but_rules(interaction, server_ids);
        break;
      }
      default: {
        break;
      }
    }
  });

  // messagecreate listener
  client.on("messageCreate", async (message: Message) => {
    //ignore if this is not in a guild
    if (!message.guild) {
      return;
    }

    //let command_and_args = message.content.split(/\b(\s)/);

    //check if it is url
    const matches = message.content.match(/\bhttps?:\/\/\S+/gi);

    if (
      matches &&
      !(await should_whitelist(
        client,
        message,
        knex_instance,
        matches,
        server_ids
      ))
    ) {
      console.log("did not pass the whitelist. deleting message.");
      // we delete message
      message
        .delete()
        .then((msg) =>
          console.log(`Deleted message from ${msg.author.username}`)
        )
        .catch(console.error);
    }
    // check if it is command

    const command_and_args = message.content.match(/\S+/g);

    if (!command_and_args) return;

    if (command_and_args.length < 1) {
      return;
    }

    // commands
    switch (command_and_args[0]) {
      case ".mute": {
        if (can_member_whitelist(message.member!, server_ids)) {
          command_mute(message, command_and_args.slice(1));
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".bot_post_role_message": {
        if (can_member_whitelist(message.member!, server_ids)) {
          command_post_role_message(message, server_ids);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".bot_post_rules": {
        if (can_member_whitelist(message.member!, server_ids)) {
          command_post_rules(message);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".bot_add_default_roles_to_everyone": {
        if (can_member_whitelist(message.member!, server_ids)) {
          const ids = server_ids.get(message.guild!.id);

          if (!ids) {
            console.log("The server that you are in is not in the database.");
            return;
          }

          // get all members
          message.guild.members.fetch().then((members) => {
            const add_promises: Promise<GuildMember>[] = [];

            members!.forEach((member) => {
              // for each, add default roles to everyone.
              add_promises.push(
                member.roles.add([ids.menu_roles[0], ids.menu_roles[1]])
              );
            });

            Promise.all(add_promises)
              .then(() => {
                message.reply("All ");
              })
              .catch((err) => {
                message.reply("Something went wrong.");
                console.log(err);
              });
          });

          command_post_rules(message);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".whitelist_user": {
        if (command_and_args.length < 2) return;
        if (can_member_whitelist(message.member!, server_ids)) {
          command_whitelist_user(message, knex_instance);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".whitelist_channel": {
        if (command_and_args.length < 2) return;
        if (can_member_whitelist(message.member!, server_ids)) {
          command_whitelist_channel(message, knex_instance);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".whitelist_url": {
        if (command_and_args.length < 2) return;
        if (can_member_whitelist(message.member!, server_ids)) {
          const urls = command_and_args.slice(1);
          command_whitelist_url(urls, message, knex_instance);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
      case ".display_entire_audit_log": {
        if (can_member_whitelist(message.member!, server_ids)) {
          print_all_audit_logs(client, server_ids);
        } else {
          // Post that u don't have the authority to use this command.
          message.reply("You can't use that command.");
        }
        break;
      }
    }
  });

  const token = process.env["BEAM_BOT_TOKEN"];

  if (!token) {
    console.error(
      "env variable BEAM_BOT_TOKEN is undefined. Please define it."
    );
    process.exit(1);
  } else {
    client.login(token);
  }
}

function add_to_whitelist<T>(knex_inst: Knex, table: string, wl_value: T) {
  return (
    knex_inst<T>(table)
      // @ts-ignore
      .insert(wl_value)
  );
}

// --------------- COMMAND functions ----------------

//post the rules
function command_post_rules(message: Message) {
  const rules_de = [
    "Seid nett und freundlich zu einander. Beleidigt, belästigt oder diskriminiert nicht mit faschistischen, rassistischen, homo/transphoben, sexistischen und/oder Menschen - verachtenden Äußerungen oder Reactions.",
    "Bitte kein 18+ Content. D.h. nicht in Text, Bild, Video, Profil, Username, etc. Gewalt- und Drogenkonsum verherrlichende Inhalte sind ebenfalls verboten.",
    "Störung der Kommunikation, Belästigung und Beleidigung sowie Provokation und jegliches Bedrohen von Nutzern im Voice/Schreibchat ist untersagt. Dazu zählt auch unnötiges pingen und/oder spammen.",
    "Die Stimme, Webcam & Bildschirmübertragung anderer User, darf ohne deren Einverständnis unter keinen Umständen aufgenommen/weiterverarbeitet werden.",
    "Kein nervendes Nachfragen nach gebannten Personen. (wenn eine Person gebannt ist, kann diese Person @BeKa per PN anschreiben (bei DC Bann). Und per Ticket bei mute um die Angelegenheit klären)",
    "Das Benutzen von Zweitaccounts, sowie das Umgehen von Mutes, Banns usw. führt zu sofortigem permanentem Ausschluss.",
    "Probleme auf Beam´s Spiele Servern, sowie auf dem DC werden ausschließlich über das Ticket-System geklärt.",
    "Keine Fremdserverwerbung. Auch nicht in Verbindung mit Tribe/Member suche. Außerdem sind nur Links von Beams Infoblättern oder von Ingame - Screenshots erlaubt. ",
    "Beachtet bitte auch die Discord Community Richtlinien. https://discord.com/guidelines",
  ];

  const rules_en = [
    "Be nice and friendly to each other,  no insulting, discrimination including, sexism, fascism, racism, homophobic, transphobic and sexist language. Please use common sense.",
    "No 18+ content in text messages, including videos, pictures, profile pictures, profiles and status and usernames, no glorifying drug use or violence.",
    "No disrupting or disturbing people in voice or text chat or trying to provoke or threatening people, please follow the other rules at all times.",
    "No unneeded pinging or spamming other members or messages.",
    "Recording of other users voice, webcam, streams or screensharing is prohibited without permission and awareness of all involved. ",
    "No repetitive questions about the bans of other members or yourself, appeals should be sent to @BeKa via private message, only if it is a ban from Beam's discord. For any other punishment a ticket must be opened. ",
    "Ban evasion is prohibited, trying to get around a ban with alt accounts will result in permanent ban without warning.",
    "All problems relating to Beam's game servers and discord will exclusively answered with tickets, no questions will be answered via private messages ",
    "No unsolicited advertisement's, this includes tribe or member search by you or on behalf of others, Links are not allowed excluding beam project information or in-game screenshots. (Special allowance may be available for twitch subs or discord boosters) ",
    "Please also follow the discord community guidelines: https://discord.com/guidelines",
  ];

  const the_embed_de = new MessageEmbed()
    .setTitle("Regeln")
    .setColor(embed_color)
    .setFooter({ text: "11.03.2022" });

  let rules_str = "";

  rules_de.forEach((rule) => {
    rules_str = rules_str.concat("- ", rule, "\n\n");
  });

  the_embed_de.setDescription(rules_str);

  const the_embed_en = new MessageEmbed()
    .setTitle("Rules")
    .setColor(embed_color)
    .setFooter({ text: "11.03.2022" });

  rules_str = "";

  rules_en.forEach((rule) => {
    rules_str = rules_str.concat("- ", rule, "\n\n");
  });

  the_embed_en.setDescription(rules_str);

  const row = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("rules-accept")
      .setLabel("Akzeptieren / Accept")
      .setStyle("PRIMARY")
  );

  return message.channel
    .send({
      embeds: [the_embed_de],
      files: [
        {
          attachment: "assets/Banner_Rules.png",
          name: "banner_rules.png",
          description: "Rules Banner",
        },
      ],
    })
    .then((_) => {
      return message.channel.send({
        embeds: [the_embed_en],
        files: [
          {
            attachment: "assets/Banner_Rules_En.png",
            name: "banner_rules.png",
            description: "Rules Banner",
          },
        ],
        components: [row],
      });
    })
    .then((_) => console.log("Sent rules"))
    .catch(console.error);
}

//post the role message
function command_post_role_message(message: Message, server_ids: Server_IDs) {
  const ids = server_ids.get(message.guild!.id);

  if (!ids) {
    console.log("The server that you are in is not in the database.");
    return;
  }

  const the_embed = new MessageEmbed()
    .setColor(embed_color)
    .setTitle("Rules")
    .addFields({
      name: "Durch Klicken auf den entsprechenden Button könnt ihr euch die Rolle selbst geben und nehmen.",
      value: `Die Stream und Videorolle bekommen alle standardmäßig. Wenn ihr bei Streams oder Videos nicht gepingt werden wollt, könnt ihr sie durch klicken auf den jeweiligen Button wieder entfernen.

<@&${ids.menu_roles[0]}> = Werde bei jedem Stream von Beam gepingt.
<@&${ids.menu_roles[1]}> = Werde bei jedem Video von Beam gepingt.
<@&${ids.menu_roles[2]}> = Infos & Events rund um den PvE Community Server.
<@&${ids.menu_roles[3]}> = Infos & Events rund um den Deathmatch Server.`,
    });

  const row = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("roles-stream")
      .setLabel("Stream")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("roles-video")
      .setLabel("Video")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("roles-ark-pve")
      .setLabel("Ark PvE")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("roles-ark-dm")
      .setLabel("Ark Deathmatch")
      .setStyle("PRIMARY")
  );

  message.channel
    .send({
      embeds: [the_embed],
      files: [
        {
          attachment: "assets/Beam Rollenmanager.png",
          name: "banner_role_manager.png",
          description: "Role Manager Banner",
        },
      ],
      components: [row],
    })
    .then((_) => console.log("sent role message"))
    .catch(console.error);
}

//TODO: You just rewrote this whole function. test it and do the TODO's inside!!!
//TODO: do error checking with try/catch on await stuff.
async function post_audit_log(channel: TextChannel, knex_instance: Knex) {
  const fetch_limit = 3;

  const update_last_entry = function (last_entry: string) {
    knex_instance
      .raw(
        "insert or replace into last_audits values(:guild_id,:last_entry_id)",
        {
          guild_id: channel.guild!.id,
          last_entry_id: last_entry,
        }
      )
      .then(() => console.log("last audit value inserted."))
      .catch(console.error);
  };

  const fetch_forever = async function (
    last_entry_id: string
  ): Promise<GuildAuditLogsEntry[]> {
    let before_id: string | undefined = undefined;
    let total_entries: GuildAuditLogsEntry[] = [];

    // first entry index where u should start posting
    //  >= entries.length, post nothing.
    let index_where_should_post = 0;

    while (true) {
      const log_entries = await channel.guild!.fetchAuditLogs({
        limit: fetch_limit,
        before: before_id,
      });

      let the_entries = log_entries.entries;

      //this sorts it from oldest -> newest (oldest will be the first item)
      the_entries = the_entries.sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
      );
      const the_entries_arr = Array.from(the_entries.values());

      total_entries = the_entries_arr.concat(total_entries);

      let should_break = false;

      for (let i = 0; i < total_entries.length; ++i) {
        if (total_entries[i].id == last_entry_id) {
          index_where_should_post = i + 1;
          should_break = true;
          break;
        }
      }

      if (should_break) {
        break;
      }

      if (the_entries.size < fetch_limit) {
        break;
      }

      console.log("last entry not found in this batch. fetching again.");

      before_id = the_entries.firstKey()! as string;
    }

    //Cutting the posts that were already posted
    total_entries = total_entries.slice(index_where_should_post);

    return total_entries;
  };

  //fetch_forever();

  knex_instance
    .select("audit_entry_id")
    .from("last_audits")
    .where("server_id", channel.guild!.id)
    .then(async (last_entry_id_arr) => {
      if (last_entry_id_arr.length == 0) {
        //marking the last entry id as the last id

        console.log("there is no last entry posted. inserting a last entry.");
        const last_log_entries = await channel.guild!.fetchAuditLogs({
          limit: 1,
        });

        if (last_log_entries.entries.size == 0) {
          console.log("there are no audit log entries. do nothing.");
          // there are no audit log entries. do nothing.
          return;
        }

        const last_log_entry = last_log_entries.entries.lastKey();

        update_last_entry(last_log_entry!);

        return;
      }

      const last_entry_id: string = last_entry_id_arr[0].audit_entry_id;
      return fetch_forever(last_entry_id);
    })
    .then((new_entries) => {
      if (!new_entries || new_entries.length == 0) {
        return;
      }

      new_entries = new_entries!;
      const send_promises = [];

      for (let i = 0; i < new_entries.length; ++i) {
        // let entry = new_entries[i];
        // let post_str = `action:${entry.action}
        //   action_type:${entry.actionType}
        //   reason:${entry?.reason}
        // `;

        // send_promises.push(channel.send(post_str));
        send_promises.push(format_audit_entry(channel, new_entries[i]));
      }

      Promise.all(send_promises)
        .then(() => {
          console.log("all audit logs posted. updating last entry id.");
          update_last_entry(new_entries![new_entries!.length - 1].id);
        })
        .catch(console.error);
    });
}

//whitelist commands.
function command_whitelist_user(message: Message, knex_instance: Knex) {
  const mentions = message.mentions.members;

  mentions!.forEach((member) => {
    console.log("user id: ", member.user.id);
    const the_id = member.user.id;

    add_to_wl_and_handle_error(
      knex_instance,
      "whitelisted_users",
      {
        user_id: the_id,
      },
      member.displayName,
      message
    );
  });
}

function command_whitelist_channel(message: Message, knex_instance: Knex) {
  const mentions = message.mentions.channels;
  mentions!.forEach((channel) => {
    console.log("channel id: ", channel.id);
    const the_id = channel.id;

    // add to db
    add_to_wl_and_handle_error(
      knex_instance,
      "whitelisted_channels",
      {
        channel_id: the_id,
      },
      channel,
      message
    );
  });
}

function command_mute(message: Message, args: string[]) {
  const mentions = message.mentions.members;

  if (mentions?.size == 0) {
    message.reply("You have to mention at least one member.");
    return;
  }

  const days = parseInt(args[args.length - 1], 10);
  if (isNaN(days)) {
    message.reply("You must specify the amount of days.");
    return;
  }

  mentions!.forEach((member) => {
    member
      .timeout(1000 * 60 * 60 * 24 * days)
      .then(() =>
        message.reply(`${member.displayName} was muted for ${days} days.`)
      )
      .catch((e) => {
        if (e instanceof Error) {
          if (
            e.name == "DiscordAPIError" &&
            e.message == "Missing Permissions"
          ) {
            message.reply(
              `Missing Permissions error. Could not mute member, probably because the member is an Administrator.`
            );
          } else {
            console.log("Error when muting user.");
            console.log(e.message);
          }
        }
      });
  });
}

function command_whitelist_url(
  urls: string[],
  message: Message,
  knex_instance: Knex
) {
  urls.forEach((url) => {
    // add to db
    add_to_wl_and_handle_error(
      knex_instance,
      "whitelisted_urls",
      {
        url: url,
      },
      url,
      message
    );
  });
}
// -------------- /COMMANDS end ----------

// ---------- Button interactions ------------
function clicked_but_roles(
  interaction: ButtonInteraction,
  server_ids: Server_IDs
) {
  const ids = server_ids.get(interaction.guild!.id);

  if (!ids) {
    console.log("The server that you are in is not in the database.");
    return;
  }

  let role_id = ids.menu_roles[0];

  // get member and role.
  switch (interaction.customId) {
    case "roles-stream": {
      role_id = ids.menu_roles[0];
      break;
    }
    case "roles-video": {
      role_id = ids.menu_roles[1];
      break;
    }
    case "roles-ark-pve": {
      role_id = ids.menu_roles[2];
      break;
    }
    case "roles-ark-dm": {
      role_id = ids.menu_roles[3];
      break;
    }
    default: {
      console.log("wtf did u click");
      break;
    }
  }

  interaction
    .guild!.roles.fetch(role_id)
    .then((role) => {
      const roles_manager = interaction.member!.roles as GuildMemberRoleManager;

      if (roles_manager.cache.some((role) => role.id === role_id)) {
        //has role, remove it
        return [roles_manager.remove(role!), false];
      } else {
        //does not have role, add it
        return [roles_manager.add(role!), true];
      }
    })
    .then(([_, was_added]) => {
      let reply_str = "";
      if (was_added) {
        reply_str = "Role assigned.";
      } else {
        reply_str = "Role removed.";
      }

      return interaction.reply({
        content: reply_str,
        ephemeral: true,
      });
    })
    .then(() => console.log("Reply sent."))
    .catch(console.error);
}

//Clicked on "accept" on #rules
function clicked_but_rules(
  interaction: ButtonInteraction,
  server_ids: Server_IDs
) {
  console.log("clicked on agreed rules");
  const ids = server_ids.get(interaction.guild!.id);

  if (!ids) {
    console.log("The server that you are in is not in the database.");
    return;
  }

  interaction
    .guild!.roles.fetch(ids.user_role)
    .then((role) => {
      const roles_manager = interaction.member!.roles as GuildMemberRoleManager;
      return roles_manager.add(role!);
    })
    .then((_) => {
      const reply_str = "You now have access to the server.";

      return interaction.reply({
        content: reply_str,
        ephemeral: true,
      });
    });
}

//--------------- /Button interactions -------------

function get_db_error(e: any): DBError {
  if (e instanceof Error) {
    if (
      e.message.includes("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed")
    ) {
      return DBError.DuplicateError;
    } else {
      return DBError.OtherError;
    }
  }
  return DBError.OtherError;
}

function add_to_wl_and_handle_error<T>(
  knex_inst: Knex,
  table: string,
  wl_value: T,
  t_in_str: any,
  message: Message
) {
  add_to_whitelist(knex_inst, table, wl_value)
    .then((_) => {
      message.channel.send(`${t_in_str} was added to the whitelist.`);
    })
    .catch((e) => {
      switch (get_db_error(e)) {
        case DBError.DuplicateError: {
          message.channel.send(`${t_in_str} is already whitelisted.`);
          break;
        }
        case DBError.OtherError: {
          console.log(e);
          message.channel.send("Database error. Please try again.");
          break;
        }
      }
    });
}

//TODO test this func
function give_roles(m: GuildMember, role_ids: string[]) {
  return m.roles!.add(role_ids);
}

async function should_whitelist(
  client: Client,
  message: Message,
  knex_instance: Knex,
  urls: string[],
  server_ids: Server_IDs
): Promise<boolean> {
  const ids = server_ids.get(message.guild!.id);

  if (!ids) {
    console.log("The server that you are in is not in the database.");
    return false;
  }

  // check if message is from own bot
  if (client.user!.id == message.member!.user.id) {
    console.log("url is ok bc it's the bot");
    return true;
  }

  // check if message is from someone on whitelisted roles
  if (
    message.member!.roles.cache.some((role) =>
      ids.whitelisted_roles.includes(role.id)
    )
  ) {
    console.log("url is ok bc has whitelisted role");
    return true;
  }

  // check if message is in whitelisted channel
  const channels = await knex_instance
    .select("channel_id")
    .from<WhitelistedChannel>("whitelisted_channels")
    .where("channel_id", message.channel.id);
  if (channels && channels.length > 0) {
    console.log("url is ok bc channel");
    return true;
  }

  // check if user is whitelisted
  const users = await knex_instance
    .select("user_id")
    .from<WhitelistedUser>("whitelisted_users")
    .where("user_id", message.member!.user.id);
  if (users && users.length > 0) {
    console.log("url is ok bc user");
    return true;
  }

  // check if url is whitelisted
  const found_urls = await knex_instance
    .select("url")
    .from<WhitelistedUrl>("whitelisted_urls")
    .whereIn("url", urls);
  if (found_urls && found_urls.length == urls.length) {
    console.log("url is ok bc urls");
    return true;
  }

  return false;
}

function run_audit_log(
  client: Client,
  knex_instance: Knex,
  server_ids: Map<string, RelevantIDs>
) {
  const check_func = (channel: TextChannel) => {
    post_audit_log(channel, knex_instance);
  };

  const check_log_period_secs = 30;

  for (const guild_id of server_ids.keys()) {
    client.guilds
      .fetch(guild_id)
      .then((guild) => {
        const guild_channels = server_ids.get(guild_id)!;
        return guild.channels.fetch(guild_channels.audit_log_channel_id);
        //now get the channel
      })
      .then((channel) => {
        const text_channel = channel as TextChannel;
        check_func(text_channel);
        setInterval(() => {
          check_func(text_channel);
        }, check_log_period_secs * 1000);
      });
  }

  //TODO check if the guild is available. guild.available
}

function can_member_whitelist(
  member: GuildMember,
  server_ids: Server_IDs
): boolean {
  const ids = server_ids.get(member.guild!.id);

  if (!ids) {
    console.log("The server that you are in is not in the database.");
    return false;
  }

  if (
    member.roles.cache.some((role) => ids.whitelist_mod_roles.includes(role.id))
  ) {
    return true;
  }

  return false;
}

function format_audit_entry(
  channel: TextChannel,
  entry: GuildAuditLogsEntry
): Promise<Message> {
  let the_embed = new MessageEmbed()
    .setColor(embed_color)
    .setDescription("not done yet");

  //<@userid> for tagging member
  //<#channelid> for tagging channel
  //<@&roleid> for tagging role

  let the_title = "action type not implemented";
  let the_description = "no description";

  switch (entry.action as string) {
    case "GUILD_UPDATE": {
      the_title = "Guild Update";
      the_description = `<@${entry.executor!.id}> has modified guild data`;
      break;
    }
    case "CHANNEL_CREATE": {
      the_title = "Channel Created";
      the_description = `<@${
        entry.executor!.id
      }> has created a new channel: <#${entry.target!.id}>`;
      break;
    }
    case "CHANNEL_UPDATE": {
      the_title = "Channel Updated";
      the_description = `<@${entry.executor!.id}> has updated the channel: <#${
        entry.target!.id
      }>`;
      break;
    }
    case "CHANNEL_DELETE": {
      the_title = "Channel Deleted";
      the_description = `<@${entry.executor!.id}> has deleted the channel: <#${
        entry.target!.id
      }>`;
      break;
    }
    case "CHANNEL_OVERWRITE_CREATE": {
      the_title = "Channel Overwrite created";
      the_description = `<@${
        entry.executor!.id
      }> has created a channel overwrite for the channel: <#${
        entry.target!.id
      }>`;
      break;
    }
    case "CHANNEL_OVERWRITE_UPDATE": {
      the_title = "Channel Overwrite updated";
      the_description = `<@${
        entry.executor!.id
      }> has updated a channel overwrite for the channel: <#${
        entry.target!.id
      }>`;
      break;
    }
    case "CHANNEL_OVERWRITE_DELETE": {
      the_title = "Channel Overwrite deleted";
      the_description = `<@${
        entry.executor!.id
      }> has deleted a channel overwrite for the channel: <#${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_KICK": {
      the_title = "Member Kicked";
      the_description = `<@${entry.executor!.id}> has kicked <@${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_PRUNE": {
      the_title = "Member Prune";
      the_description = `<@${entry.executor!.id}> has pruned members`;
      break;
    }
    case "MEMBER_BAN_ADD": {
      the_title = "Member ban";
      the_description = `<@${entry.executor!.id}> has banned <@${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_BAN_REMOVE": {
      the_title = "Ban removed";
      the_description = `<@${entry.executor!.id}> has removed the ban on <@${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_UPDATE": {
      the_title = "Member Update";
      the_description = `<@${
        entry.executor!.id
      }> has updated the member data of <@${entry.target!.id}>`;
      break;
    }
    case "MEMBER_ROLE_UPDATE": {
      the_title = "Member Role Update";
      the_description = `<@${entry.executor!.id}> has updated the roles of <@${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_MOVE": {
      the_title = "Member Move";
      the_description = `<@${entry.executor!.id}> has moved <@${
        entry.target!.id
      }>`;
      break;
    }
    case "MEMBER_DISCONNECT": {
      the_title = "Member Move";
      the_description = `<@${entry.executor!.id}> has moved <@${
        entry.target!.id
      }>`;
      break;
    }
    case "BOT_ADD": {
      the_title = "Bot Added";
      the_description = `<@${entry.executor!.id}> has added a bot: <@${
        entry.target!.id
      }>`;
      break;
    }
    case "ROLE_CREATE": {
      the_title = "Role Creation";
      the_description = `<@${entry.executor!.id}> has created a role: <@&${
        entry.target!.id
      }>`;
      break;
    }
    case "ROLE_UPDATE": {
      the_title = "Role Updated";
      the_description = `<@${entry.executor!.id}> has updated a role: <@&${
        entry.target!.id
      }>`;
      break;
    }
    case "ROLE_DELETE": {
      the_title = "Role Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a role: <@&${
        entry.target!.id
      }>`;
      break;
    }
    case "INVITE_CREATE": {
      the_title = "Invite Creation";
      the_description = `<@${entry.executor!.id}> has created a server invite`;
      break;
    }
    case "INVITE_UPDATE": {
      the_title = "Invite Updated";
      the_description = `<@${entry.executor!.id}> has updated a server invite`;
      break;
    }
    case "INVITE_DELETE": {
      the_title = "Invite Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a server invite`;
      break;
    }
    case "WEBHOOK_CREATE": {
      the_title = "Webhook Created";
      the_description = `<@${entry.executor!.id}> has created a webhook`;
      break;
    }
    case "WEBHOOK_UPDATE": {
      the_title = "Webhook Created";
      the_description = `<@${entry.executor!.id}> has updated a webhook`;
      break;
    }
    case "WEBHOOK_DELETE": {
      the_title = "Webhook Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a webhook`;
      break;
    }
    case "EMOJI_CREATE": {
      the_title = "Emoji Created";
      the_description = `<@${entry.executor!.id}> has created an emoji`;
      break;
    }
    case "EMOJI_UPDATE": {
      the_title = "Emoji Updated";
      the_description = `<@${entry.executor!.id}> has updated an emoji`;
      break;
    }
    case "EMOJI_DELETE": {
      the_title = "Emoji Deleted";
      the_description = `<@${entry.executor!.id}> has deleted an emoji`;
      break;
    }
    case "MESSAGE_DELETE": {
      the_title = "Message Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a message`;
      // TODO(lucypero): show the message contents and who wrote the message
      break;
    }
    case "MESSAGE_BULK_DELETE": {
      the_title = "Message Bulk Deletion";
      the_description = `<@${entry.executor!.id}> has bulk deleted messages`;
      break;
    }
    case "MESSAGE_PIN": {
      the_title = "Message Pinned";
      the_description = `<@${entry.executor!.id}> has pinned a message`;
      // TODO(lucypero): show the message contents and who wrote the message
      break;
    }
    case "MESSAGE_UNPIN": {
      the_title = "Message Unpinned";
      the_description = `<@${entry.executor!.id}> has unpinned a message`;
      // TODO(lucypero): show the message contents and who wrote the message
      break;
    }
    case "INTEGRATION_CREATE": {
      the_title = "Integration Created";
      the_description = `<@${entry.executor!.id}> has created an integration`;
      break;
    }
    case "INTEGRATION_UPDATE": {
      the_title = "Integration Updated";
      the_description = `<@${entry.executor!.id}> has updated an integration`;
      break;
    }
    case "INTEGRATION_DELETE": {
      the_title = "Integration Deleted";
      the_description = `<@${entry.executor!.id}> has deleted an integration`;
      break;
    }
    case "STAGE_INSTANCE_CREATE": {
      the_title = "Stage Instance Created";
      the_description = `<@${entry.executor!.id}> has created a stage instance`;
      break;
    }
    case "STAGE_INSTANCE_UPDATE": {
      the_title = "Stage Instance Updated";
      the_description = `<@${entry.executor!.id}> has updated a stage instance`;
      break;
    }
    case "STAGE_INSTANCE_DELETE": {
      the_title = "Stage Instance Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a stage instance`;
      break;
    }
    case "STICKER_CREATE": {
      the_title = "Sticker Created";
      the_description = `<@${entry.executor!.id}> has created a sticker`;
      break;
    }
    case "STICKER_UPDATE": {
      the_title = "Sticker Updated";
      the_description = `<@${entry.executor!.id}> has updated a sticker`;
      break;
    }
    case "STICKER_DELETE": {
      the_title = "Sticker Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a sticker`;
      break;
    }
    case "GUILD_SCHEDULED_EVENT_CREATE": {
      the_title = "Scheduled Event Created";
      the_description = `<@${
        entry.executor!.id
      }> has created a scheduled event`;
      break;
    }
    case "GUILD_SCHEDULED_EVENT_UPDATE": {
      the_title = "Scheduled Event Updated";
      the_description = `<@${
        entry.executor!.id
      }> has updated a scheduled event`;
      break;
    }
    case "GUILD_SCHEDULED_EVENT_DELETE": {
      the_title = "Scheduled Event Deleted";
      the_description = `<@${
        entry.executor!.id
      }> has deleted a scheduled event`;
      break;
    }
    case "THREAD_CREATE": {
      the_title = "Thread Created";
      the_description = `<@${entry.executor!.id}> has created a thread`;
      break;
    }
    case "THREAD_UPDATE": {
      the_title = "Thread Updated";
      the_description = `<@${entry.executor!.id}> has updated a thread`;
      break;
    }
    case "THREAD_DELETE": {
      the_title = "Thread Deleted";
      the_description = `<@${entry.executor!.id}> has deleted a thread`;
      break;
    }
    default: {
      break;
    }
  }

  the_embed = the_embed.setTitle(the_title);
  if (entry.executor) {
    the_embed = the_embed.setDescription(the_description);
  }

  if (entry.changes) {
    let change_str = "";

    entry.changes.forEach((change) => {
      change_str += `key: \`\`\`${change.key}\`\`\``;
      change_str += `old: \`\`\`${JSON.stringify(change.old, null, 4)}\`\`\``;
      change_str += `new: \`\`\`${JSON.stringify(change.new, null, 4)}\`\`\``;
      change_str += `\n`;
    });

    the_embed = the_embed.addFields({
      name: "Changes:",
      value: change_str,
    });
  }

  if (entry.reason) {
    the_embed = the_embed.addFields({
      name: "Reason:",
      value: entry.reason,
    });
  }

  return channel.send({
    embeds: [the_embed],
  });
}

// NOTE(lucypero): for debug
async function print_all_audit_logs(
  client: Client,
  server_ids: Map<string, RelevantIDs>
) {
  const fetch_limit = 100;

  const print_stuff = async function (channel: TextChannel) {
    const log_entries = await channel.guild!.fetchAuditLogs({
      limit: fetch_limit,
    });

    let the_entries = log_entries.entries;

    //this sorts it from oldest -> newest (oldest will be the first item)
    the_entries = the_entries.sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    const the_entries_arr = Array.from(the_entries.values());
    for (const entry of the_entries_arr) {
      format_audit_entry(channel, entry);
    }
    //console.log(the_entries_arr);
  };

  for (const guild_id of server_ids.keys()) {
    client.guilds
      .fetch(guild_id)
      .then((guild) => {
        const guild_channels = server_ids.get(guild_id)!;
        return guild.channels.fetch(guild_channels.audit_log_channel_id);
        //now get the channel
      })
      .then((channel) => {
        const text_channel = channel as TextChannel;
        print_stuff(text_channel);
      });
  }
}

async function get_server_ids(knex_instance: Knex): Promise<Server_IDs> {
  const server_ids = new Map<string, RelevantIDs>([]);

  // interface ServerID {
  //   server_id: string;
  //   description: string;
  //   ord: number;
  //   the_id: string;
  // }

  let rows = await knex_instance.select("*").from("server_ids");

  rows = rows.sort((a, b) => {
    if (a.server_id == b.server_id) {
      if (a.description == b.description) {
        return a.ord - b.ord;
      } else {
        return a.description - b.description;
      }
    } else {
      return a.server_id - b.server_id;
    }
  });

  let current_server_id = rows[0].server_id;
  let rel_ids: RelevantIDs = {
    audit_log_channel_id: "",
    whitelist_mod_roles: [],
    whitelisted_roles: [],
    user_role: "",
    menu_roles: [],
  };

  for (const row of rows) {
    if (row.server_id != current_server_id) {
      // we are done parsing all the ids of a server.
      server_ids.set(current_server_id, rel_ids);
      current_server_id = row.server_id;
      rel_ids = {
        audit_log_channel_id: "",
        whitelist_mod_roles: [],
        whitelisted_roles: [],
        user_role: "",
        menu_roles: [],
      };
    }

    switch (row.description) {
      case "audit_log_channel": {
        rel_ids.audit_log_channel_id = row.the_id;
        break;
      }
      case "whitelist_mod_role": {
        rel_ids.whitelist_mod_roles.push(row.the_id);
        break;
      }
      case "whitelisted_role": {
        rel_ids.whitelisted_roles.push(row.the_id);

        break;
      }
      case "user_role": {
        rel_ids.user_role = row.the_id;
        break;
      }
      case "menu_role": {
        rel_ids.menu_roles.push(row.the_id);
        break;
      }
    }
  }

  server_ids.set(current_server_id, rel_ids);
  return server_ids;
}

main();
