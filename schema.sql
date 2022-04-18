CREATE TABLE `users` (`id` integer not null primary key autoincrement, `user_name` varchar(255));
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE `accounts` (`id` integer not null primary key autoincrement, `account_name` varchar(255), `user_id` integer, foreign key(`user_id`) references `users`(`id`));
CREATE TABLE whitelisted_channels (`channel_id` varchar(255) NOT NULL UNIQUE);
CREATE TABLE whitelisted_urls (`url` varchar(255) not null unique);
CREATE TABLE whitelisted_users (`user_id` varchar(255) not null unique);
CREATE TABLE user_roles (
id integer not null primary key autoincrement,
user_id varchar(255) not null,
role_id varchar(255) not null,
unique(user_id, role_id)
);
CREATE TABLE last_audits (
  server_id varchar(255) PRIMARY KEY,
  audit_entry_id varchar(255) not null);
CREATE TABLE server_ids (
server_id varchar(255) not null,
description varchar(255) not null,
ord integer not null,
the_id varchar(255) not null,
unique(server_id, the_id)
);
